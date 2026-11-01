/**
 * Structured-output verification.
 *
 * Codex enforces the schema it was given, but a completed turn is not proof that
 * the answer the host received is valid JSON or that it still matches the
 * schema: the app-server can be replaced, a stub can answer, and a later change
 * to the wire can hand the caller prose. Treating an unparseable answer as
 * "structured output absent" would report exactly the success the caller asked
 * to avoid, so this module fails closed and returns the reason.
 *
 * The validator deliberately covers the JSON Schema subset this plugin accepts
 * for `output_schema` (object-rooted schemas using the common assertion
 * keywords). A schema using a keyword outside that subset is reported as an
 * error rather than silently accepted; the plugin never claims a validation it
 * did not perform.
 *
 * @module dsh-subagent-codex-pro/structured
 */

/** The verification result for one schema-constrained answer. */
export type StructuredVerification =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

/** JSON value primitives the validator can see in a decoded answer. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Keywords that are assertions in the supported subset. */
const ASSERTION_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
])

/** Annotation-only keywords that do not affect validation. */
const ANNOTATION_KEYS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'format',
])

/** Keywords this validator does not implement; accepting them silently would be a lie. */
const UNSUPPORTED_KEYS = new Set([
  '$ref',
  '$defs',
  'definitions',
  'patternProperties',
  'propertyNames',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'minContains',
  'maxContains',
  'if',
  'then',
  'else',
  'prefixItems',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
])

/** Human names for JSON types. */
function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Whether a JSON value matches one JSON Schema `type` name. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    default: return true
  }
}

/** Deep equality for JSON values, used by enum/const/uniqueItems. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return false
  if (typeof left !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJson(value, right[index]))
  }
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
}

/** Add one validation failure to a shared list, with a dotted path. */
function fail(errors: string[], path: string, message: string): void {
  errors.push(`${path || 'value'}: ${message}`)
}

/** Resolve a local `$ref` only to report that refs are unsupported. */
function checkSchemaShape(schema: unknown, path: string, errors: string[]): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    fail(errors, path, 'schema must be an object')
    return
  }
  const record = schema as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (UNSUPPORTED_KEYS.has(key)) fail(errors, path, `unsupported schema keyword ${key}`)
    else if (!ASSERTION_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) {
      // Unknown annotation-like keywords are harmless to validation, but an
      // unknown keyword can also be a constraint this validator would skip.
      // Failing closed is safer than claiming a schema was checked.
      fail(errors, path, `unsupported schema keyword ${key}`)
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = record[key]
    if (branches === undefined) continue
    if (!Array.isArray(branches) || branches.length === 0) {
      fail(errors, `${path}.${key}`, 'must be a non-empty array of schemas')
      continue
    }
    branches.forEach((branch, index) => checkSchemaShape(branch, `${path}.${key}[${String(index)}]`, errors))
  }
  const properties = record.properties
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      fail(errors, `${path}.properties`, 'must be an object of schemas')
    } else {
      for (const [name, child] of Object.entries(properties)) checkSchemaShape(child, `${path}.properties.${name}`, errors)
    }
  }
  const additional = record.additionalProperties
  if (additional !== undefined && typeof additional !== 'boolean') checkSchemaShape(additional, `${path}.additionalProperties`, errors)
  if (record.items !== undefined) checkSchemaShape(record.items, `${path}.items`, errors)
  if (record.not !== undefined) checkSchemaShape(record.not, `${path}.not`, errors)
}

/** Validate one decoded JSON value against the supported schema subset. */
function validate(value: unknown, schema: unknown, path: string, errors: string[]): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    fail(errors, path, 'schema must be an object')
    return
  }
  const record = schema as Record<string, unknown>
  if (Array.isArray(record.type)) {
    if (!record.type.some((type) => typeof type === 'string' && matchesType(value, type))) {
      fail(errors, path, `expected ${record.type.join('|')}, got ${jsonType(value)}`)
    }
  } else if (typeof record.type === 'string' && !matchesType(value, record.type)) {
    fail(errors, path, `expected ${record.type}, got ${jsonType(value)}`)
  }
  if (Array.isArray(record.enum) && !record.enum.some((candidate) => sameJson(candidate, value))) {
    fail(errors, path, 'value is not in enum')
  }
  if (Object.hasOwn(record, 'const') && !sameJson(record.const, value)) fail(errors, path, 'value does not equal const')

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const required = record.required
    if (Array.isArray(required)) {
      for (const name of required) if (typeof name === 'string' && !Object.hasOwn(object, name)) fail(errors, path, `missing required property ${name}`)
    }
    const properties = record.properties
    const known = typeof properties === 'object' && properties !== null && !Array.isArray(properties)
      ? properties as Record<string, unknown>
      : undefined
    if (known !== undefined) {
      for (const [name, child] of Object.entries(known)) {
        if (Object.hasOwn(object, name)) validate(object[name], child, `${path}.${name}`, errors)
      }
    }
    const additional = record.additionalProperties
    if (additional === false) {
      const names = Object.keys(object).filter((name) => known === undefined || !Object.hasOwn(known, name))
      for (const name of names) fail(errors, path, `additional property ${name} is not allowed`)
    } else if (typeof additional === 'object' && additional !== null) {
      const names = Object.keys(object).filter((name) => known === undefined || !Object.hasOwn(known, name))
      for (const name of names) validate(object[name], additional, `${path}.${name}`, errors)
    }
    if (typeof record.minProperties === 'number' && Object.keys(object).length < record.minProperties) fail(errors, path, 'too few properties')
    if (typeof record.maxProperties === 'number' && Object.keys(object).length > record.maxProperties) fail(errors, path, 'too many properties')
  }

  if (Array.isArray(value)) {
    if (typeof record.items === 'object' && record.items !== null) {
      value.forEach((item, index) => validate(item, record.items, `${path}[${String(index)}]`, errors))
    }
    if (typeof record.minItems === 'number' && value.length < record.minItems) fail(errors, path, 'too few items')
    if (typeof record.maxItems === 'number' && value.length > record.maxItems) fail(errors, path, 'too many items')
    if (record.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        if (value.slice(0, i).some((earlier) => sameJson(earlier, value[i]))) {
          fail(errors, path, 'items are not unique')
          break
        }
      }
    }
  }

  if (typeof value === 'string') {
    if (typeof record.minLength === 'number' && value.length < record.minLength) fail(errors, path, 'string is too short')
    if (typeof record.maxLength === 'number' && value.length > record.maxLength) fail(errors, path, 'string is too long')
    if (typeof record.pattern === 'string') {
      try {
        if (!new RegExp(record.pattern, 'u').test(value)) fail(errors, path, 'string does not match pattern')
      } catch {
        fail(errors, path, 'schema pattern is not a valid regular expression')
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof record.minimum === 'number' && value < record.minimum) fail(errors, path, 'number is below minimum')
    if (typeof record.maximum === 'number' && value > record.maximum) fail(errors, path, 'number is above maximum')
    if (typeof record.exclusiveMinimum === 'number' && value <= record.exclusiveMinimum) fail(errors, path, 'number is not above exclusiveMinimum')
    if (typeof record.exclusiveMaximum === 'number' && value >= record.exclusiveMaximum) fail(errors, path, 'number is not below exclusiveMaximum')
    if (typeof record.multipleOf === 'number' && record.multipleOf > 0) {
      const quotient = value / record.multipleOf
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) fail(errors, path, 'number is not a multipleOf')
    }
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = record[key]
    if (!Array.isArray(branches)) continue
    const results = branches.map((branch) => {
      const branchErrors: string[] = []
      validate(value, branch, path, branchErrors)
      return branchErrors
    })
    if (key === 'allOf') for (const branchErrors of results) errors.push(...branchErrors)
    else if (key === 'anyOf' && !results.some((branchErrors) => branchErrors.length === 0)) fail(errors, path, 'value matches no anyOf branch')
    else if (key === 'oneOf') {
      const matches = results.filter((branchErrors) => branchErrors.length === 0).length
      if (matches !== 1) fail(errors, path, `value matches ${String(matches)} oneOf branches, expected 1`)
    }
  }
  if (record.not !== undefined) {
    const notErrors: string[] = []
    validate(value, record.not, path, notErrors)
    if (notErrors.length === 0) fail(errors, path, 'value matches a forbidden not schema')
  }
}

/**
 * Parse and validate one schema-constrained final answer.
 *
 * @param text - the final answer text, exactly as Codex returned it.
 * @param schema - the object-rooted schema the answer was asked to conform to.
 * @returns the decoded value, or the reason verification failed.
 */
export function verifyStructuredOutput(text: string, schema: unknown): StructuredVerification {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: 'the answer was empty, so it cannot contain a structured result' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as Json
  } catch (error: unknown) {
    return { ok: false, error: `the answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const shapeErrors: string[] = []
  checkSchemaShape(schema, 'schema', shapeErrors)
  if (shapeErrors.length > 0) return { ok: false, error: `the output schema cannot be verified: ${shapeErrors.join('; ')}` }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'the answer is not a JSON object' }
  }
  const errors: string[] = []
  validate(parsed, schema, 'value', errors)
  return errors.length === 0 ? { ok: true, value: parsed } : { ok: false, error: `the answer does not match the schema: ${errors.slice(0, 8).join('; ')}` }
}

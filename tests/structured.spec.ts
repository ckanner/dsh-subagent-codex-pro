/**
 * Structured-output verification.
 *
 * A completed Codex turn is not proof that the host received valid JSON that
 * still matches the schema. These cases pin the fail-closed rule: parse and
 * schema violations return an explicit error rather than a silent "structured
 * absent".
 *
 * @module dsh-subagent-codex-pro/tests/structured
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { verifyStructuredOutput } from '../src/structured.ts'

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'count'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    count: { type: 'integer', minimum: 0 },
    notes: { type: 'string', maxLength: 80 },
  },
} as const

test('accepts an object that satisfies the schema', () => {
  const result = verifyStructuredOutput(JSON.stringify({ verdict: 'pass', count: 2 }), schema)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value, { verdict: 'pass', count: 2 })
})

test('rejects prose, an empty answer, and a non-object JSON value', () => {
  for (const text of ['not json', '', '  ', '[1,2,3]', 'null', '"pass"']) {
    const result = verifyStructuredOutput(text, schema)
    assert.equal(result.ok, false, `expected ${JSON.stringify(text)} to fail`)
  }
})

test('rejects missing required fields, wrong types, enum and range violations', () => {
  const cases = [
    '{"verdict":"pass"}',
    '{"verdict":"pass","count":"two"}',
    '{"verdict":"maybe","count":2}',
    '{"verdict":"fail","count":-1}',
    '{"verdict":"pass","count":2,"notes":"' + 'x'.repeat(81) + '"}',
    '{"verdict":"pass","count":2,"extra":true}',
  ]
  for (const text of cases) {
    const result = verifyStructuredOutput(text, schema)
    assert.equal(result.ok, false, `expected ${text} to fail`)
  }
})

test('the error reports why verification failed', () => {
  const result = verifyStructuredOutput('{"verdict":"pass"}', schema)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /missing required property count/)
})

test('a schema using an unsupported keyword fails closed', () => {
  const result = verifyStructuredOutput('{"value":1}', {
    type: 'object',
    properties: { value: { type: 'number' } },
    $ref: '#/$defs/value',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /unsupported schema keyword \$ref/)
})

test('annotation-only schema keywords do not fail verification', () => {
  const result = verifyStructuredOutput('{"verdict":"pass","count":0}', {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Verdict',
    description: 'A smoke verdict',
    type: 'object',
    required: ['verdict', 'count'],
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      count: { type: 'integer' },
    },
  })
  assert.equal(result.ok, true)
})

test('array, string, number, and property-bound keywords are enforced', () => {
  const cases: [string, unknown][] = [
    ['{"value":[1,1]}', { type: 'object', properties: { value: { type: 'array', uniqueItems: true } } }],
    ['{"value":[1]}', { type: 'object', properties: { value: { type: 'array', minItems: 2 } } }],
    ['{"value":[1,2,3]}', { type: 'object', properties: { value: { type: 'array', maxItems: 2 } } }],
    ['{"value":"ab"}', { type: 'object', properties: { value: { type: 'string', pattern: '^z' } } }],
    ['{"value":"a"}', { type: 'object', properties: { value: { type: 'string', minLength: 2 } } }],
    ['{"value":"abc"}', { type: 'object', properties: { value: { type: 'string', maxLength: 2 } } }],
    ['{"value":1}', { type: 'object', properties: { value: { type: 'number', exclusiveMinimum: 1 } } }],
    ['{"value":1}', { type: 'object', properties: { value: { type: 'number', exclusiveMaximum: 1 } } }],
    ['{"value":5}', { type: 'object', properties: { value: { type: 'number', maximum: 4 } } }],
    ['{"value":5}', { type: 'object', properties: { value: { type: 'number', multipleOf: 2 } } }],
    ['{"a":1}', { type: 'object', minProperties: 2 }],
    ['{"a":1,"b":2,"c":3}', { type: 'object', maxProperties: 2 }],
    ['{"a":1}', { type: 'object', additionalProperties: false }],
    ['{"a":"x"}', { type: 'object', additionalProperties: { type: 'number' } }],
    ['[1,2]', { type: 'array', items: { type: 'number' } }],
  ]
  for (const [text, schema] of cases) {
    const result = verifyStructuredOutput(text, schema)
    assert.equal(result.ok, false, `expected ${text} to fail with ${JSON.stringify(schema)}`)
  }
})

test('allOf, anyOf, oneOf, not, and type unions are evaluated', () => {
  const base = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }
  assert.equal(verifyStructuredOutput('{"n":2}', { ...base, allOf: [{ properties: { n: { minimum: 2 } } }] }).ok, true)
  assert.equal(verifyStructuredOutput('{"n":2}', { ...base, anyOf: [{ properties: { n: { maximum: 1 } } }, { properties: { n: { minimum: 2 } } }] }).ok, true)
  assert.equal(verifyStructuredOutput('{"n":2}', { ...base, anyOf: [{ properties: { n: { maximum: 1 } } }] }).ok, false)
  assert.equal(verifyStructuredOutput('{"n":2}', { ...base, oneOf: [{ properties: { n: { minimum: 1 } } }, { properties: { n: { minimum: 2 } } }] }).ok, false)
  assert.equal(verifyStructuredOutput('{"n":2}', { ...base, not: { properties: { n: { minimum: 2 } } } }).ok, false)
  assert.equal(verifyStructuredOutput('{"n":"2"}', { type: 'object', properties: { n: { type: ['number', 'null'] } } }).ok, false)
  assert.equal(verifyStructuredOutput('{"n":null}', { type: 'object', properties: { n: { type: ['number', 'null'] } } }).ok, true)
})

test('malformed schema shapes fail closed', () => {
  const schemas: unknown[] = [
    [],
    { type: 'object', properties: [] },
    { type: 'object', anyOf: [] },
    { type: 'object', anyOf: [42] },
    { type: 'object', items: 4 },
    { type: 'object', additionalProperties: 4 },
    { type: 'object', not: 4 },
    { type: 'object', patternProperties: { '^x': { type: 'string' } } },
  ]
  for (const schema of schemas) {
    const result = verifyStructuredOutput('{}', schema)
    assert.equal(result.ok, false, `expected malformed schema ${JSON.stringify(schema)} to fail`)
  }
})

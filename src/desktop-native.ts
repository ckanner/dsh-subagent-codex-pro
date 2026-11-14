/** Desktop configuration and per-call policy over the shared native protocol. */
import { parseNativeRequest, type NativeRequest, type NativeReceipt } from './native.ts'

/** Undefined inherits CLI defaults; null explicitly disables native agents. */
export type DesktopNative = NativeRequest | null
/** Schemastery's volatile output, kept structural so the machine API stays independent. */
export interface NativeSetting { get(): DesktopNative | undefined }
export type NativeConfigValue = DesktopNative | NativeSetting

/** Read one immutable snapshot for this delegation, including live settings updates. */
export function readNativeDefault(setting: NativeConfigValue | undefined): NativeRequest | undefined {
  const value = setting !== null && typeof setting === 'object' && 'get' in setting
    ? (setting as NativeSetting).get() : setting
  return parseDesktopNative(value)
}

/** A normal delegation cannot silently turn into review/start, which ignores its prompt. */
export function parseDesktopNative(value: unknown): NativeRequest | undefined {
  if (value === undefined) return undefined
  if (value === null) return { version: 1, agents: { enabled: false } }
  const parsed = parseNativeRequest(value)
  if (parsed.review !== undefined) {
    throw new Error('codex-pro: native.review is an explicit operation; use subagent_codex_review, not delegation defaults')
  }
  return parsed
}

/**
 * A supplied native object replaces the whole default. Off never retains
 * concurrency, model, effort, or backend settings from an enabled default.
 */
export function resolveDesktopNative(
  defaults: NativeRequest | undefined, override: DesktopNative | undefined, modelSelection: boolean,
): NativeRequest | undefined {
  if (override === undefined) return defaults === undefined ? undefined : structuredClone(defaults)
  const native = parseDesktopNative(override)!
  if (!modelSelection && native.agents?.enabled) {
    for (const field of ['defaultModel', 'defaultEffort'] as const) {
      if (native.agents[field] !== defaults?.agents?.[field]) {
        throw new Error('codex-pro: modelSelection is disabled; native.agents.' + field
          + ' must match the configured default (including omission); change plugin settings to select another child model or effort')
      }
    }
  }
  return native
}

/** Stable identity for implicit session reuse, independent of JSON key order. */
export function nativeSessionKey(
  native: NativeRequest | undefined, cwd: string, model: string | undefined,
  effort: string | undefined, permission: string,
): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
    }
    return value
  }
  return JSON.stringify([native === undefined ? 'cli-defaults' : stable(native), cwd, model ?? null, effort ?? null, permission])
}

/**
 * Bounded, valid JSON metadata for Host diagnostics and error-only surfaces.
 * Full receipts remain available in direct-tool and background-job results.
 */
export function nativeDiagnostic(native: NativeReceipt): string {
  const states: Record<string, number> = {}
  const known = new Set(['running', 'completed', 'failed', 'closed', 'shutdown', 'errored', 'interrupted', 'notFound'])
  for (const child of native.children) {
    const state = known.has(child.state) ? child.state : 'other'
    states[state] = (states[state] ?? 0) + 1
  }
  const ids = (values: string[]): { ids: string[]; count: number; abbreviated: boolean } => ({
    ids: values.slice(0, 4).map(id => Buffer.from(id).subarray(0, 24).toString('utf8')), count: values.length,
    abbreviated: values.length > 4 || values.some(id => Buffer.byteLength(id) > 24),
  })
  return JSON.stringify({
    native: {
      version: 1, effectiveMatched: native.effective.matched,
      completion: { confirmed: native.completion.confirmed, pending: ids(native.completion.pendingIds) },
      cleanup: { confirmed: native.cleanup.confirmed, scope: native.cleanup.scope, pending: ids(native.cleanup.pendingIds) },
      children: { count: native.children.length, states },
      usage: { strategy: native.usage.strategy, scope: native.usage.scope, status: native.usage.status, totalTokens: native.usage.totalTokens },
      events: { count: native.observed.events.length, truncated: native.observed.truncated },
    },
  })
}

/** Public tool schema; the shared parser also enforces it for direct callers. */
export const desktopNativeSchema: Record<string, unknown> = {
  description: 'Omit to use the plugin native default (or CLI defaults when none is configured). null explicitly turns agents off. '
    + 'An object replaces the complete native default; no nested fields are merged. Review uses subagent_codex_review. '
    + 'When modelSelection is disabled, an enabled override must retain exactly the configured child model and effort.',
  anyOf: [
    { type: 'null' },
    { type: 'object', additionalProperties: false, required: ['version'], properties: {
      version: { type: 'integer', const: 1 },
      agents: { type: 'object', additionalProperties: false, required: ['enabled'], properties: {
        enabled: { type: 'boolean' },
        maxConcurrentThreads: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 },
        defaultModel: { type: 'string', minLength: 1 },
        defaultEffort: { type: 'string', minLength: 1 },
        backend: { type: 'string', const: 'v2' },
      } },
    } },
  ],
}

/** Explicit, operation-specific target. There is no prompt that review could ignore. */
export const reviewTargetSchema: Record<string, unknown> = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['type'],
      properties: { type: { const: 'uncommittedChanges', type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'branch'],
      properties: { type: { const: 'baseBranch', type: 'string' }, branch: { type: 'string', minLength: 1 } } },
    { type: 'object', additionalProperties: false, required: ['type', 'sha'],
      properties: { type: { const: 'commit', type: 'string' }, sha: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 } } },
    { type: 'object', additionalProperties: false, required: ['type', 'instructions'],
      properties: { type: { const: 'custom', type: 'string' }, instructions: { type: 'string', minLength: 1 } } },
  ],
}

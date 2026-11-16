/** Observed provider activity is separate from answers and durable lifecycle ACKs. */
export const MACHINE_ACTIVITY_VERSION = 1 as const
export const MACHINE_ACTIVITY_CAPABILITIES = Object.freeze({ version: 1, metadataOnly: true,
  coalesced: true, rootAndChildren: true })

export const ACTIVITY_EVENT_TYPES = Object.freeze([
  'turn/started', 'turn/completed', 'item/started', 'item/completed',
  'item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta',
  'item/commandExecution/outputDelta', 'item/mcpToolCall/progress',
  'turn/plan/updated', 'turn/diff/updated', 'thread/tokenUsage/updated',
] as const)
const known = new Set<string>(ACTIVITY_EVENT_TYPES)
export type ActivityScope = 'root' | 'child' | 'mixed'
export interface ActivityEvent {
  readonly version: 1
  readonly sequence: number
  readonly kind: 'provider-progress'
  readonly source: 'codex-pro'
  readonly scope: ActivityScope
  readonly eventTypes: readonly string[]
  readonly observedEvents: number
}

export function validActivity(value: unknown): value is ActivityEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(k => ['version', 'sequence', 'kind', 'source', 'scope', 'eventTypes', 'observedEvents'].includes(k))
    && v.version === 1 && v.kind === 'provider-progress' && v.source === 'codex-pro'
    && Number.isSafeInteger(v.sequence) && Number(v.sequence) > 0
    && Number.isSafeInteger(v.observedEvents) && Number(v.observedEvents) > 0
    && ['root', 'child', 'mixed'].includes(String(v.scope))
    && Array.isArray(v.eventTypes) && v.eventTypes.length > 0 && v.eventTypes.length <= ACTIVITY_EVENT_TYPES.length
    && v.eventTypes.every(t => typeof t === 'string' && known.has(t))
    && new Set(v.eventTypes).size === v.eventTypes.length
}

export function activityInterval(value: number | undefined): number {
  if (value === undefined) return 250
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error('activityIntervalMs must be an integer between 1 and 60000')
  return value
}

/** No timer: a report is emitted only while processing a new owned event. */
export function createActivityReporter(report: ((event: ActivityEvent) => void) | undefined, intervalMs?: number):
  (scope: 'root' | 'child', method: string) => void {
  const interval = activityInterval(intervalMs)
  let last = -Infinity, sequence = 0, observed = 0, scope: ActivityScope | undefined
  const types = new Set<string>()
  return (owner, method) => {
    if (!report || !known.has(method)) return
    observed = Math.min(Number.MAX_SAFE_INTEGER, observed + 1)
    types.add(method)
    scope = scope === undefined ? owner : scope === owner ? scope : 'mixed'
    const now = performance.now()
    if (now - last < interval) return
    const event: ActivityEvent = { version: 1, sequence: ++sequence, kind: 'provider-progress', source: 'codex-pro',
      scope, eventTypes: [...types], observedEvents: observed }
    last = now; observed = 0; scope = undefined; types.clear()
    try { report(event) } catch { /* Observations cannot authorize or cancel a turn. */ }
  }
}

import { randomUUID } from 'node:crypto'
import { activityInterval, type ActivityEvent } from './activity.ts'
import type { AgentLike, Context } from './dsh-types.ts'

/** Optional Flywheel extension, not an invented DSH core event or model message. */
export interface FlywheelProviderActivity {
  readonly version: 1
  readonly intervalMs: number
  report(agent: AgentLike, event: ActivityEvent & { readonly invocationId: string }): void
}

export function hostActivity(host: Pick<Context, 'get'> | undefined, agent: AgentLike, signal: AbortSignal): {
  onActivity?: (event: ActivityEvent) => void; activityIntervalMs?: number
} {
  let service: FlywheelProviderActivity
  try {
    const value = host?.get('flywheelProviderActivity') as Partial<FlywheelProviderActivity> | undefined
    if (!value || value.version !== 1 || typeof value.report !== 'function' || value.intervalMs === undefined) return {}
    activityInterval(value.intervalMs)
    service = value as FlywheelProviderActivity
  } catch { return {} }
  const invocationId = randomUUID()
  return { activityIntervalMs: service.intervalMs, onActivity: event => {
    if (signal.aborted) return
    try { service.report(agent, { ...event, invocationId }) } catch { /* Optional telemetry cannot alter execution. */ }
  } }
}

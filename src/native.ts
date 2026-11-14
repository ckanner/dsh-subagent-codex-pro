/** Versioned controls and evidence for Codex's native child threads. */
import { TokenUsageTracker, type CodexUsageReport } from './usage.ts'

export const MACHINE_NATIVE_VERSION = 1 as const
export const MACHINE_NATIVE_CAPABILITIES = Object.freeze({ version: 1, agents: true, review: true,
  images: true, structuredOutput: true, childEvents: true, cleanup: 'local-process-group', remoteJobs: false })

export type NativeReviewTarget = { type: 'uncommittedChanges' } | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string } | { type: 'custom'; instructions: string }
export interface NativeRequest {
  readonly version: 1
  readonly agents?: { readonly enabled: boolean; readonly maxConcurrentThreads?: number
    readonly defaultModel?: string; readonly defaultEffort?: string; readonly backend?: 'v2' }
  readonly review?: { readonly target: NativeReviewTarget }
}
export interface NativeEvent {
  readonly version: 1
  readonly sequence: number
  readonly kind: string
  readonly id: string
  readonly parentId: string | null
  readonly state: string
  readonly turnId?: string
  readonly model?: string
}
export interface NativeChild {
  id: string; parentId: string | null; kind: string; state: string; model: string | null; turnId: string | null
  usage: CodexUsageReport | null
}
export interface NativeReceipt {
  version: 1; requested: NativeRequest
  effective: { source: string | null; matched: boolean; config: Record<string, unknown> | null }
  observed: { events: NativeEvent[]; truncated: boolean }
  children: NativeChild[]
  usage: { strategy: 'per-thread'; scope: 'observed-children'; status: 'complete' | 'partial' | 'unknown'; children: Record<string, CodexUsageReport>; totalTokens: number | null }
  completion: { confirmed: boolean; pendingIds: string[] }
  cleanup: { confirmed: boolean; scope: 'local-process-group'; pendingIds: string[] }
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !v.includes('\0') && Buffer.byteLength(v) <= 65536
const keys = (v: Record<string, unknown>, allowed: string[]): boolean => Object.keys(v).every(k => allowed.includes(k))
const terminalStates = new Set(['completed', 'failed', 'closed', 'shutdown', 'errored', 'interrupted', 'notFound'])

/** Reject unsupported controls, instead of silently dropping a policy. */
export function parseNativeRequest(value: unknown): NativeRequest {
  if (!object(value) || !keys(value, ['version', 'agents', 'review']) || value.version !== 1) throw new Error('invalid native capability version or fields')
  const agents = value.agents
  if (agents !== undefined) {
    if (!object(agents) || !keys(agents, ['enabled', 'maxConcurrentThreads', 'defaultModel', 'defaultEffort', 'backend']) || typeof agents.enabled !== 'boolean') throw new Error('native.agents needs an explicit enabled boolean')
    if (agents.maxConcurrentThreads !== undefined && (!Number.isSafeInteger(agents.maxConcurrentThreads) || Number(agents.maxConcurrentThreads) < 1)) throw new Error('native agents concurrency must be a positive safe integer')
    for (const field of ['defaultModel', 'defaultEffort']) if (agents[field] !== undefined && !text(agents[field])) throw new Error(`invalid native agents ${field}`)
    if (agents.backend !== undefined && agents.backend !== 'v2') throw new Error('invalid native agent backend')
    if (agents.maxConcurrentThreads === Number.MAX_SAFE_INTEGER) throw new Error('native concurrency must leave room for the root thread')
    if (agents.enabled === false && Object.keys(agents).length !== 1) throw new Error('disabled agents cannot have active controls')
  }
  if (value.review !== undefined) {
    if (!object(value.review) || !keys(value.review, ['target']) || !object(value.review.target)) throw new Error('native review needs an explicit target')
    const target = value.review.target
    const fields: Record<string, string[]> = { uncommittedChanges: ['type'], baseBranch: ['type', 'branch'], commit: ['type', 'sha', 'title'], custom: ['type', 'instructions'] }
    if (typeof target.type !== 'string' || !fields[target.type] || !keys(target, fields[target.type]!)) throw new Error('unsupported native review target')
    for (const field of fields[target.type]!.filter(f => f !== 'type' && f !== 'title')) if (!text(target[field])) throw new Error(`review target requires ${field}`)
    if (target.title !== undefined && !text(target.title)) throw new Error('invalid review title')
  }
  return structuredClone(value) as unknown as NativeRequest
}

/** Each override is passed as one argv value; never interpolated into a shell. */
export function nativeConfig(request: NativeRequest, review: { model?: string | undefined; effort?: string | undefined } = {}): Record<string, unknown> {
  const a = request.agents ?? { enabled: false }
  return { 'agents.enabled': a.enabled,
    ...(!a.enabled ? { 'features.multi_agent_v2': false } : a.backend === 'v2' ? { 'features.multi_agent_v2': { enabled: true, disable_native_tools: false, ...(a.maxConcurrentThreads === undefined ? {} : { max_concurrent_threads_per_session: a.maxConcurrentThreads + 1 }) } } : {}),
    ...(request.review && review.model !== undefined ? { review_model: review.model } : {}),
    ...(request.review && review.effort !== undefined ? { model_reasoning_effort: review.effort } : {}),
    ...(a.maxConcurrentThreads === undefined ? {} : { 'agents.max_concurrent_threads_per_session': a.maxConcurrentThreads }),
    ...(a.defaultModel === undefined ? {} : { 'agents.default_subagent_model': a.defaultModel }),
    ...(a.defaultEffort === undefined ? {} : { 'agents.default_subagent_reasoning_effort': a.defaultEffort }) }
}
function toml(value: unknown): string {
  if (object(value)) return '{ ' + Object.entries(value).map(([key, item]) => `${key} = ${toml(item)}`).join(', ') + ' }'
  return JSON.stringify(value)
}
export function nativeArguments(request: NativeRequest | undefined, review: { model?: string | undefined; effort?: string | undefined } = {}): string[] {
  return request === undefined ? [] : Object.entries(nativeConfig(request, review)).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])
}

/** Identity must be established by a parent relation, never by an arbitrary notification. */
export class NativeTracker {
  readonly request: NativeRequest
  #root: string | undefined
  #children = new Map<string, NativeChild>()
  #usage = new Map<string, TokenUsageTracker>()
  #fresh = new Set<string>()
  #turns = new Map<string, Set<string>>()
  #history = new Map<string, { method: string; params: Record<string, unknown> }[]>()
  #orphans: { method: string; params: Record<string, unknown> }[] = []
  #expected: Record<string, unknown>
  #events: NativeEvent[] = []
  #seen = new Set<string>()
  #sequence = 0
  #truncated = false
  #effective: NativeReceipt['effective'] = { source: null, matched: false, config: null }
  #report: ((event: NativeEvent) => void) | undefined
  constructor(request: NativeRequest, report?: (event: NativeEvent) => void, review: { model?: string | undefined; effort?: string | undefined } = {}) { this.request = request; this.#report = report; this.#expected = nativeConfig(request, review) }
  get configurationOverrides(): Record<string, unknown> { return structuredClone(this.#expected) }
  setRoot(id: string): void { this.#root = id; this.#replayOrphans() }
  #replayOrphans(): void {
    const pending = this.#orphans.splice(0)
    for (const event of pending) this.observe(event.method, event.params)
  }
  verifyConfiguration(response: unknown): void {
    const config = object(response) && object(response.config) ? response.config : null
    const expected = this.#expected
    const actual: Record<string, unknown> = {}
    for (const key of Object.keys(expected)) {
      const [group, field] = key.split('.') as [string, string]
      const nested = config?.[group]
      actual[key] = config?.[key] ?? (object(nested) ? nested[field] : undefined) ?? null
    }
    const matches = (a: unknown, b: unknown): boolean => object(a) && object(b) ? Object.entries(b).every(([k, v]) => matches(a[k], v)) : a === b
    let matched = Object.entries(expected).every(([k, v]) => matches(actual[k], v))
    const v2 = object(config?.features) ? config.features.multi_agent_v2 : undefined
    if (this.request.agents?.enabled && object(v2) && v2.enabled !== false) {
      if (v2.disable_native_tools === true) matched = false
      const cap = this.request.agents.maxConcurrentThreads
      if (cap !== undefined && typeof v2.max_concurrent_threads_per_session === 'number' && v2.max_concurrent_threads_per_session > cap + 1) matched = false
      actual['effectiveV2'] = v2
    }
    this.#effective = { source: 'config/read', matched, config: actual }
    if (!matched) throw new Error('Codex did not confirm the requested native configuration before dispatch')
  }
  owns(id: unknown): boolean { return typeof id === 'string' && (id === this.#root || this.#children.has(id)) }
  #record(kind: string, child: NativeChild): void {
    const key = JSON.stringify([kind, child.id, child.parentId, child.state, child.turnId, child.model])
    if (this.#seen.has(key)) return
    if (this.#events.length >= 4096) { this.#truncated = true; return }
    this.#seen.add(key)
    const event: NativeEvent = { version: 1, sequence: ++this.#sequence, kind, id: child.id, parentId: child.parentId,
      state: child.state, ...(child.turnId === null ? {} : { turnId: child.turnId }), ...(child.model === null ? {} : { model: child.model }) }
    this.#events.push(event)
    try { this.#report?.(event) } catch { /* Observations are not dispatch approvals. */ }
  }
  acceptsTurn(id: unknown, turnId: unknown, nullable = false): boolean {
    const child = typeof id === 'string' ? this.#children.get(id) : undefined
    return child !== undefined && ((nullable && turnId === null) || (typeof turnId === 'string' && child.turnId === turnId))
  }
  #child(id: unknown, parent: unknown, kind = 'agent', fresh = false): NativeChild | undefined {
    if (!text(id) || id === this.#root || !this.owns(parent)) return undefined
    const existing = this.#children.get(id)
    if (existing) {
      if (fresh && !this.#fresh.has(id)) {
        this.#fresh.add(id)
        const tracker = new TokenUsageTracker(); tracker.resetForNewThread(id); this.#usage.set(id, tracker)
        for (const event of this.#history.get(id) ?? []) this.#foldUsage(existing, event.method, event.params)
      }
      return existing
    }
    if (this.#children.size >= 4096) throw new Error('native child evidence exceeds its bounded ledger')
    if (this.request.agents?.enabled !== true) throw new Error('native child dispatch was observed while agents were disabled')
    const child: NativeChild = { id, parentId: String(parent), kind, state: 'created', model: null, turnId: null, usage: null }
    this.#children.set(id, child)
    const tracker = new TokenUsageTracker(); if (fresh) { tracker.resetForNewThread(id); this.#fresh.add(id) } else tracker.resetForResume(id); this.#usage.set(id, tracker)
    this.#record('child-created', child)
    this.#replayOrphans()
    return child
  }
  observe(method: string, params: unknown): void {
    if (!object(params)) return
    if (method === 'thread/started' && object(params.thread)) {
      const t = params.thread
      const source = object(t.source) ? t.source : object(t.sessionSource) ? t.sessionSource : undefined
      const sub = source && object(source.subAgent) ? source.subAgent : source && object(source.subagent) ? source.subagent : undefined
      const spawn = sub && object(sub.thread_spawn) ? sub.thread_spawn : sub && object(sub.threadSpawn) ? sub.threadSpawn : undefined
      const child = this.#child(t.id, t.parentThreadId ?? spawn?.parent_thread_id ?? spawn?.parentThreadId)
      if (child) { if (text(t.model)) child.model = t.model; return }
    }
    const item = object(params.item) ? params.item : undefined
    if (item && (item.type === 'collabAgentToolCall' || item.type === 'collaborationToolCall')) {
      const parent = item.senderThreadId ?? params.threadId
      if (!this.owns(parent)) return
      const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
      for (const id of ids) {
        const child = this.#child(id, parent, 'agent', item.tool === 'spawnAgent')
        if (!child) continue
        const states = object(item.agentsStates) ? item.agentsStates : undefined
        const state: Record<string, unknown> | undefined = states && object(states[child.id]) ? states[child.id] as Record<string, unknown> : undefined
        if (state && text(state.status)) child.state = state.status
        if (text(item.model)) child.model = item.model
        this.#record('child-state', child)
      }
    }
    if (item?.type === 'subAgentActivity') {
      const child = this.#child(item.agentThreadId, params.threadId, 'agent', item.kind === 'started')
      if (child) {
        if (text(item.model)) child.model = item.model
        if (text(item.kind)) child.state = item.kind === 'started' ? 'running' : item.kind
        this.#record('child-activity', child)
      }
    }
    const child = typeof params.threadId === 'string' ? this.#children.get(params.threadId) : undefined
    if (!child) {
      // thread/started carries its identity inside `thread`, even before the
      // root/start response establishes our owner. Keep that bounded ancestry
      // evidence so later child requests can be routed to the correct turn.
      const id = method === 'thread/started' && object(params.thread) ? params.thread.id : params.threadId
      if (text(id) && id !== this.#root && ['thread/tokenUsage/updated', 'turn/started', 'turn/completed', 'thread/started'].includes(method)) {
        if (this.#orphans.length < 128) this.#orphans.push({ method, params })
        else this.#truncated = true
      }
      return
    }
    if (method === 'turn/started' && object(params.turn) && text(params.turn.id)) {
      const turns = this.#turns.get(child.id) ?? new Set<string>()
      if (turns.has(params.turn.id)) return
      if (turns.size >= 4096) { this.#truncated = true; return }
      turns.add(params.turn.id); this.#turns.set(child.id, turns)
    }
    if (['thread/tokenUsage/updated', 'turn/started'].includes(method)) {
      const history = this.#history.get(child.id) ?? []
      if (history.length < 128) { history.push({ method, params }); this.#history.set(child.id, history) }
      else if (!this.#fresh.has(child.id)) this.#truncated = true
    }
    this.#foldUsage(child, method, params)
    if (method === 'turn/started' && object(params.turn) && text(params.turn.id)) {
      child.turnId = params.turn.id; child.state = 'running'
      this.#record('child-turn-started', child)
    } else if (method === 'turn/completed' && object(params.turn) && text(params.turn.id)) {
      // A resumed child can emit a late completion for its preceding turn.
      // Keep the live turn identity for approval routing and interruption.
      if (child.turnId !== null && child.turnId !== params.turn.id) return
      child.turnId = params.turn.id; child.state = text(params.turn.status) ? params.turn.status : 'unknown'
      this.#record('child-turn-completed', child)
    } else if (method === 'thread/closed') {
      child.state = 'closed'; this.#record('child-closed', child)
    }
  }
  #foldUsage(child: NativeChild, method: string, params: Record<string, unknown>): void {
    const tracker = this.#usage.get(child.id)
    if (method === 'turn/started' && object(params.turn) && text(params.turn.id)) tracker?.beginTurn(params.turn.id)
    else if (method === 'thread/tokenUsage/updated') tracker?.observe(params)
  }
  running(): { threadId: string; turnId: string }[] {
    return [...this.#children.values()].filter(c => c.state === 'running' && c.turnId !== null).map(c => ({ threadId: c.id, turnId: c.turnId! }))
  }
  report(cleanupConfirmed = false): NativeReceipt {
    const usage: Record<string, CodexUsageReport> = {}
    for (const [id, tracker] of this.#usage) {
      const report = tracker.report()
      // A cumulative snapshot is attributable, but without a terminal child
      // event it is only a lower bound. Reaping processes cannot fill that gap.
      usage[id] = report.status === 'complete' && !terminalStates.has(this.#children.get(id)!.state)
        ? { ...report, status: 'partial', reason: 'child terminal consumption was not observed' } : report
    }
    const children = [...this.#children.values()].map(c => ({ ...c, usage: usage[c.id] ?? null }))
    const pending = children.filter(c => !terminalStates.has(c.state)).map(c => c.id)
    const complete = pending.length === 0 && !this.#truncated && children.every(c => c.usage?.status === 'complete')
    const total = complete ? children.reduce((sum, c) => sum + (c.usage?.run?.totalTokens ?? 0), 0) : null
    return { version: 1, requested: this.request, effective: this.#effective,
      observed: { events: [...this.#events], truncated: this.#truncated }, children,
      usage: { strategy: 'per-thread', scope: 'observed-children', status: children.length === 0 ? 'unknown' : complete ? 'complete' : 'partial', children: usage,
        totalTokens: total !== null && Number.isSafeInteger(total) && children.length > 0 ? total : null },
      completion: { confirmed: pending.length === 0 && !this.#truncated, pendingIds: pending },
      cleanup: { confirmed: cleanupConfirmed, scope: 'local-process-group', pendingIds: cleanupConfirmed ? [] : pending } }
  }
}

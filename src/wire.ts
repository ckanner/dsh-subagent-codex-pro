/**
 * Codex app-server protocol adapter.
 *
 * A faithful port of `@deepseek-ai/dsh-subagent-codex`'s wire module, extended
 * with the per-call choices this package exists for: `model` and the unattended
 * permission policy on `thread/start`, per-turn `effort` on `turn/start`, and
 * explicit model/cwd/permission overrides plus effective-configuration checks
 * on `thread/resume` (0.165+). A thinking level is **not** a `thread/start`
 * field in 0.165/0.166. The module also accounts for token usage and account
 * rate limits, keeping them separate.
 *
 * Everything else is carried over as-is, because the surrounding behaviour is
 * load-bearing and was tuned against a real app-server: the initialize
 * handshake, thread/turn association (including notifications that arrive
 * before `turn/start` returns), unattended approval decisions, terminal-answer
 * selection by phase, and the failure taxonomy.
 *
 * Differences from the source, all mechanical:
 * - `JsonRpcLineTransport` is this package's own `LineTransport`, so the
 *   transport method shape is `request(method, params, { signal })` rather than
 *   a positional signal.
 * - Error text uses this package's prefix.
 * - Model and permission choices are constructor state; `effort` travels through
 *   `runTurn`; resume overrides are per call.
 *
 * @module dsh-subagent-codex-pro/wire
 */

import { isAbsolute, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

import type { LineTransport } from './jsonrpc.ts'
import { TokenUsageTracker, type CodexUsageReport, type TokenUsageNotificationLike } from './usage.ts'

/** Prefix on every error this module raises. */
const P = 'codex-pro'

/** Explicit thread permissions; approval policy never implies a sandbox. */
const THREAD_PERMISSION_PARAMS = {
  'read-only': {
    approvalPolicy: 'never',
    sandbox: 'read-only',
  },
  'workspace-write': {
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
  },
  never: { approvalPolicy: 'never' },
  'approve-for-me': {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  },
  'dangerously-bypass-approvals-and-sandbox': {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  },
} as const

/** The permission params one mode sends to thread/start and thread/resume. */
export type CodexPermissionParams = (typeof THREAD_PERMISSION_PARAMS)[CodexPermissionMode]

/** The configured permission mode. */
export type CodexPermissionMode = keyof typeof THREAD_PERMISSION_PARAMS

/** The model/cwd/permission facts a start or resume request asked for. */
export interface RequestedConfiguration {
  readonly model?: string
  readonly cwd?: string
  readonly approvalPolicy?: string
  readonly approvalsReviewer?: string
  readonly sandbox?: string
}

/** The facts the app-server reports after applying a start or resume request. */
export interface EffectiveConfiguration {
  readonly model?: string
  readonly cwd?: string
  readonly approvalPolicy?: string
  readonly approvalsReviewer?: string
  readonly sandbox?: string
  /** Full server-reported policy; matching the mode alone does not prove its roots/network scope. */
  readonly sandboxPolicy?: Readonly<Record<string, unknown>>
  /** Historical thread default, not evidence of this run's per-turn effort. */
  readonly reasoningEffort?: string | null
}

/** One path's requested/effective facts, kept for observability and comparison. */
export interface AppliedConfiguration {
  readonly source: 'thread/start' | 'thread/resume'
  readonly requested: RequestedConfiguration
  readonly effective: EffectiveConfiguration
  readonly matched: boolean
  /** Requested facts whose effective value is absent, malformed, or unsupported. */
  readonly missing: readonly (keyof RequestedConfiguration)[]
  /** Names of requested facts whose effective value differs; values are not echoed. */
  readonly mismatches: readonly (keyof RequestedConfiguration)[]
}

/** Codex acknowledges the turn, but 0.165/0.166 do not echo its effective effort. */
export interface TurnConfiguration {
  readonly requestedEffort?: string
  readonly effectiveEffort: null
  readonly evidence: 'turn/start-request'
  readonly accepted: boolean
}

/** Overrides sent on `thread/resume` instead of silently preserving history. */
export interface CodexResumeOverrides {
  /** Model override, when the caller/configuration supplied one. */
  readonly model?: string
  /** Working directory override applied to the resumed thread. */
  readonly cwd?: string
  /** Permission mode override. Omitted means preserve the thread's history. */
  readonly permission?: CodexPermissionMode
}

/** The rate-limit snapshot Codex sends separately from token usage. */
export interface CodexRateLimitsReport {
  readonly observations: number
  /** Latest `rateLimits` object, exactly as reported. */
  readonly latest?: Record<string, unknown>
}

/**
 * One image the run produced.
 *
 * Two shapes reach here. `imageView` names a file on this host, which the caller
 * can read directly — the app-server never inlines it. An MCP tool result carries
 * the bytes, which is how a computer-use screenshot arrives.
 */
export interface CodexImage {
  /** A host path to read, for `imageView`. */
  readonly path?: string
  /** Base64 bytes, for an image an MCP tool returned. */
  readonly data?: string
  /** The bytes' media type, when the source named one. */
  readonly mimeType?: string
}

/** The stop reasons one run can end with. */
export type CodexStopReason = 'completed' | 'max-tokens' | 'error' | 'aborted' | 'timeout'

/**
 * How long a thread lives.
 *
 * `ephemeral` is what this provider always did: the app-server's own notion of a
 * throwaway thread, deleted when the connection ends, leaving nothing behind.
 * `persistent` writes a rollout the Codex CLI can list and `thread/resume` can
 * continue, which is also what puts it in front of the Codex desktop application.
 */
export type CodexThreadMode = 'ephemeral' | 'persistent'

/** One text-only task submitted to a turn. */
export type TaskText = string

/** The structured failure facts observed for a turn. */
export interface CodexFailureFacts {
  readonly stage: string
  readonly category: string
  readonly httpStatus?: number
}

/** One thing that ends a turn. */
export interface TurnCompletion {
  readonly params: { readonly turn: unknown }
  readonly order: number
}

/** The end of one run. */
export interface WireRunResult {
  readonly output: readonly { readonly type: 'text'; readonly text: string }[]
  readonly stopReason: CodexStopReason
  /** Images the run produced, for a caller that can deliver them. */
  readonly images: readonly CodexImage[]
}

/** A decoded protocol object. */
type Record0 = Record<string, unknown>

/** Assert a protocol value is a non-array object. */
function object(value: unknown, label: string): Record0 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${P}: app-server returned invalid ${label}`)
  }
  return value as Record0
}

/** Assert a protocol value is a non-empty string. */
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${P}: app-server returned invalid ${label}`)
  }
  return value
}

/**
 * The only decision an unattended provider can make from what the server offers.
 *
 * @param params - the approval request's params.
 * @returns the decision to send back.
 */
function unattendedDecision(params: Record0): 'cancel' | 'decline' {
  const available = params.availableDecisions
  if (available === undefined || available === null) return 'decline'
  if (Array.isArray(available)) {
    if (available.includes('cancel')) return 'cancel'
    if (available.includes('decline')) return 'decline'
  }
  throw new Error(`${P}: app-server offered no unattended approval decision`)
}

/** A plausible HTTP status, or undefined. */
function numericHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : undefined
}

/** Classify a structured `codexErrorInfo` object. */
function objectFailureInfo(value: Record0): { category: string; httpStatus?: number } {
  const keys = Object.keys(value)
  const category = keys[0]
  if (keys.length !== 1 || category === undefined) return { category: 'unknown' }
  const detail = value[category]
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return { category: 'unknown' }
  const fields = detail as Record0
  switch (category) {
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts': {
      const httpStatus = numericHttpStatus(fields.httpStatusCode)
      return httpStatus === undefined ? { category: 'transport' } : { category: 'transport', httpStatus }
    }
    case 'activeTurnNotSteerable':
      return { category: 'product-error' }
    default:
      return { category: 'unknown' }
  }
}

/** Read the failure taxonomy out of a terminal turn. */
function failureInfo(turn: Record0): { category: string; httpStatus?: number; maxTokens?: boolean; sandboxFailure?: boolean } {
  if (turn.status !== 'failed') return { category: 'unknown' }
  const error = turn.error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return { category: 'unknown' }
  const info = (error as Record0).codexErrorInfo
  if (typeof info === 'string') {
    switch (info) {
      case 'contextWindowExceeded':
        return { category: 'limit', maxTokens: true }
      case 'sessionBudgetExceeded':
      case 'usageLimitExceeded':
        return { category: 'limit' }
      case 'serverOverloaded':
      case 'internalServerError':
        return { category: 'service' }
      case 'cyberPolicy':
      case 'misalignmentPolicyViolation':
      case 'unauthorized':
        return { category: 'access-policy' }
      case 'badRequest':
      case 'threadRollbackFailed':
      case 'other':
        return { category: 'product-error' }
      case 'sandboxError':
        return { category: 'access-policy', sandboxFailure: true }
      default:
        return { category: 'unknown' }
    }
  }
  return info !== null && typeof info === 'object' && !Array.isArray(info)
    ? objectFailureInfo(info as Record0)
    : { category: 'unknown' }
}

/**
 * One progress line for a completed non-message item.
 *
 * @param item - the completed item.
 * @returns a short human-readable line.
 */
function describeItem(item: Record0): string {
  const type = typeof item.type === 'string' ? item.type : 'item'
  const status = typeof item.status === 'string' ? ` ${item.status}` : ''
  const command = typeof item.command === 'string' ? `: ${item.command.slice(0, 120)}` : ''
  const path = typeof item.path === 'string' ? `: ${item.path.slice(0, 120)}` : ''
  return `${type}${status}${command}${path}`
}

/** Normalise an unknown throwable. */
function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** The failure produced when a signal aborts a request. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${P}: app-server request aborted: ${String(signal.reason)}`)
}

/**
 * Race one pending operation against a cancellation signal.
 *
 * @param pending - the operation.
 * @param signal - cancellation.
 * @returns the operation's value.
 */
export async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending
  if (signal.aborted) {
    pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort: (error: Error) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** The stream surface the wire reads for lifecycle events. */
export interface WireInput {
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'end', listener: () => void): unknown
  off(event: 'end', listener: () => void): unknown
}

/** The stream surface the wire writes to. */
export interface WireOutput {
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * What one wire needs beyond its transport.
 *
 * Bundled rather than positional: the caller's choice set grew past the point
 * where six positional arguments stayed readable, and every one of them is a
 * named decision the caller already holds.
 */
export interface CodexWireOptions {
  /** Unattended permission policy for the thread. */
  readonly permissionMode: CodexPermissionMode
  /** Model for `thread/start`, when the caller chose one. */
  readonly model?: string | undefined
  /** How long the thread lives. Defaults to `ephemeral`. */
  readonly threadMode?: CodexThreadMode | undefined
  /**
   * What the app-server records as the thread's originator.
   *
   * This is `initialize`'s `clientInfo.name`, and for a thread to appear in the
   * Codex desktop application it must be exactly `Codex Desktop` — that client
   * filters its list by this one value. The default here is therefore that
   * literal, and overriding it trades desktop visibility for an honest name.
   */
  readonly originator?: string | undefined
}

/** The originator the Codex desktop client lists. */
export const DEFAULT_ORIGINATOR = 'Codex Desktop'

/** The subset of a permission mode that thread requests actually send. */
function requestedPermission(permission: CodexPermissionParams): Partial<RequestedConfiguration> {
  return {
    approvalPolicy: permission.approvalPolicy,
    ...'approvalsReviewer' in permission ? { approvalsReviewer: permission.approvalsReviewer } : {},
    ...'sandbox' in permission ? { sandbox: permission.sandbox } : {},
  }
}

/** Map the app-server's sandbox policy object back to the request's mode name. */
function sandboxModeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const type = (value as Record0).type
  switch (type) {
    case 'readOnly': return 'read-only'
    case 'workspaceWrite': return 'workspace-write'
    case 'dangerFullAccess': return 'danger-full-access'
    case 'externalSandbox': return 'external-sandbox'
    default: return undefined
  }
}

/** Read the effective configuration fields a start/resume response carries. */
function effectiveConfiguration(response: Record0): EffectiveConfiguration {
  const text = (field: string): string | undefined =>
    typeof response[field] === 'string' && response[field] !== '' ? response[field] as string : undefined
  const model = text('model')
  const reportedCwd = text('cwd')
  const cwd = reportedCwd !== undefined && isAbsolute(reportedCwd) ? reportedCwd : undefined
  const approvalPolicy = text('approvalPolicy')
  const approvalsReviewer = text('approvalsReviewer')
  const sandbox = sandboxModeOf(response.sandbox)
  const reasoningEffort = response.reasoningEffort
  return {
    ...model === undefined ? {} : { model },
    ...cwd === undefined ? {} : { cwd },
    ...approvalPolicy === undefined ? {} : { approvalPolicy },
    ...approvalsReviewer === undefined ? {} : { approvalsReviewer },
    ...sandbox === undefined ? {} : { sandbox },
    ...sandbox === undefined ? {} : { sandboxPolicy: structuredClone(response.sandbox) as Record0 },
    ...reasoningEffort === null || typeof reasoningEffort === 'string'
      ? { reasoningEffort: reasoningEffort as string | null }
      : {},
  }
}

/** Codex may return a physical macOS path such as /private/tmp for /tmp. */
function sameDirectory(actual: string, requested: string): boolean {
  if (resolve(actual) === resolve(requested)) return true
  try { return realpathSync(actual) === realpathSync(requested) }
  catch { return false }
}

/**
 * Compare requested facts with the effective ones and retain both.
 *
 * The generated 0.165/0.166 start/resume responses carry effective model, cwd,
 * approval policy, reviewer and sandbox fields. A missing or malformed requested
 * field is a failed capability check, not permission to proceed. Retain the
 * facts before throwing, without echoing arbitrary protocol values in errors.
 */
function appliedConfiguration(
  source: AppliedConfiguration['source'],
  requested: RequestedConfiguration,
  response: Record0,
): AppliedConfiguration {
  const effective = effectiveConfiguration(response)
  const missing: (keyof RequestedConfiguration)[] = []
  const mismatches: (keyof RequestedConfiguration)[] = []
  const equals = (field: keyof RequestedConfiguration, actual: string, requestedValue: string): boolean =>
    field === 'cwd' ? sameDirectory(actual, requestedValue) : actual === requestedValue
  const compare = (field: keyof RequestedConfiguration, requestedValue: string | undefined): boolean => {
    if (requestedValue === undefined) return true
    const actual = effective[field]
    if (actual === undefined) {
      missing.push(field)
      return false
    }
    if (!equals(field, actual, requestedValue)) {
      mismatches.push(field)
      return false
    }
    return true
  }
  const verified = [
    compare('model', requested.model),
    compare('cwd', requested.cwd),
    compare('approvalPolicy', requested.approvalPolicy),
    compare('approvalsReviewer', requested.approvalsReviewer),
    compare('sandbox', requested.sandbox),
  ]
  return {
    source, requested, effective, matched: verified.every(Boolean), missing,
    mismatches,
  }
}

/** Refuse unproven configuration before any user task is sent. */
function requireAppliedConfiguration(configuration: AppliedConfiguration): void {
  if (configuration.matched) return
  const detail = [
    ...(configuration.missing.length === 0 ? [] : [`missing or invalid ${configuration.missing.join(', ')}`]),
    ...(configuration.mismatches.length === 0 ? [] : [`mismatched ${configuration.mismatches.join(', ')}`]),
  ].join('; ')
  throw new Error(`${P}: ${configuration.source} did not apply the requested configuration: ${detail}`)
}

/**
 * One app-server connection and its single ephemeral thread/turn.
 *
 * Deliberately exposes no generic request surface: supporting another product
 * method must first become part of the provider contract.
 */
export class CodexAppServerWire {
  #permissionMode: CodexPermissionMode
  #threadMode: CodexThreadMode
  #originator: string
  #model: string | undefined
  #transport: LineTransport
  #fatal = Promise.withResolvers<never>()
  #threadId: string | undefined
  #turnId: string | undefined
  #dispatch: 'not-dispatched' | 'possible' | 'accepted' = 'not-dispatched'
  #pendingTurnId: string | undefined
  #turnCompleted: { promise: Promise<TurnCompletion>; resolve: (value: TurnCompletion) => void } | undefined
  #earlyTurnNotifications: { method: string; params: unknown; order: number }[] = []
  /** Usage notifications that arrived before thread/start or thread/resume returned. */
  #earlyUsageNotifications: TokenUsageNotificationLike[] = []
  #earlyUsageOverflow = false
  #lastFinalAnswer: string | undefined
  /** Stable partial answer text that later assistant output or tool calls may follow. */
  #lastPartialAnswer: string | undefined
  #lastUnphasedAnswer: string | undefined
  #diagnostic: string | undefined
  /** Images the run produced, in the order the app-server reported them. */
  #images: CodexImage[] = []
  #failure: CodexFailureFacts | undefined
  #diagnosticOrder = 0
  #observationOrder = 0
  #pendingDiagnostic: { order: number; request: string; decision: string; reason: string } | undefined
  #inputEnded = false
  #terminalObserved = false
  #closed = false
  /** Token usage folds cumulative snapshots and replays into one run report. */
  readonly #usage = new TokenUsageTracker()
  /** The last rate-limit snapshot, kept separately from token usage. */
  #rateLimits: Record<string, unknown> | undefined
  #rateLimitObservations = 0
  /** Requested/effective facts of the one start or resume this wire performed. */
  #configuration: AppliedConfiguration | undefined
  #turnConfiguration: TurnConfiguration | undefined
  /** Narrates notable events, for a caller that reports progress. */
  #onProgress: ((text: string) => void) | undefined

  constructor(
    input: WireInput,
    output: WireOutput,
    transport: LineTransport,
    options: CodexWireOptions,
  ) {
    this.#permissionMode = options.permissionMode
    this.#model = options.model
    this.#threadMode = options.threadMode ?? 'ephemeral'
    this.#originator = options.originator ?? DEFAULT_ORIGINATOR
    this.#transport = transport
    this.#fatal.promise.catch(() => {})
    this.#transport.setHooks({
      onRequest: (method, params) => this.#handleServerRequest(method, params),
      onNotification: (method, params) => {
        try {
          this.#handleNotification(method, params)
        } catch (error: unknown) {
          this.#fail(thrown(error))
        }
      },
    })
    input.on('error', this.#onInputError)
    input.on('end', this.#onInputEnd)
    output.on('error', this.#onOutputError)
  }

  /**
   * Install a progress narrator.
   *
   * A delegation can run for minutes, so a caller that reports progress needs
   * the child's intermediate activity rather than only its final answer. Never
   * lets a reporter's failure reach the protocol loop.
   *
   * @param onProgress - called with one line per notable event.
   */
  setProgressReporter(onProgress: (text: string) => void): void {
    this.#onProgress = onProgress
  }

  /** Report one progress line, swallowing a reporter's own failure. */
  #progress(text: string): void {
    if (this.#onProgress === undefined) return
    try {
      this.#onProgress(text)
    } catch {
      // A progress reporter must never break the run it observes.
    }
  }

  /** Whether protocol output ended before a terminal turn notification. */
  get endedBeforeTerminal(): boolean {
    return this.#inputEnded && !this.#terminalObserved
  }

  /**
   * Perform the required initialize/initialized handshake.
   *
   * @param signal - cancellation for an unpublished start.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    object(
      await this.#guarded(
        this.#transport.request('initialize', {
          clientInfo: { name: this.#originator, title: 'DeepSeek Harness', version: '0.0.1' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        }, { signal }),
        signal,
      ),
      'initialize response',
    )
    this.#transport.notify('initialized')
    await this.#guarded(this.#transport.flush(), signal)
  }

  /**
   * Create the run's thread and retain its identity.
   *
   * `ephemeral` follows this wire's thread mode. The app-server reports the
   * decision back, and the check below is what proves it honoured the request:
   * a `persistent` thread that came back ephemeral would be a silent downgrade,
   * and the caller is about to promise the user a thread they can resume.
   *
   * @param cwd - the parent session's workspace.
   * @param signal - cancellation for an unpublished start.
   */
  async startThread(cwd: string, signal?: AbortSignal): Promise<void> {
    const permission = THREAD_PERMISSION_PARAMS[this.#permissionMode]
    const requested: RequestedConfiguration = {
      cwd,
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...requestedPermission(permission),
    }
    const response = object(
      await this.#guarded(this.#transport.request('thread/start', {
        cwd,
        ephemeral: this.#threadMode === 'ephemeral',
        ...this.#model === undefined ? {} : { model: this.#model },
        ...permission,
      }, { signal }), signal),
      'thread/start response',
    )
    const thread = object(response.thread, 'thread/start thread')
    const id = string(thread.id, 'thread/start thread id')
    if (typeof thread.ephemeral !== 'boolean') throw new Error(`${P}: app-server omitted explicit thread persistence evidence`)
    const ephemeral = thread.ephemeral === true
    if (ephemeral !== (this.#threadMode === 'ephemeral')) {
      throw new Error(`${P}: app-server created a ${ephemeral ? 'ephemeral' : 'persistent'} thread `
        + `where ${this.#threadMode} was asked for`)
    }
    this.#threadId = id
    this.#usage.resetForNewThread(id)
    this.#flushEarlyUsage()
    this.#configuration = appliedConfiguration('thread/start', requested, response)
    this.#progress(`thread ${id} (${this.#threadMode}) configuration matched=${this.#configuration.matched}`)
    requireAppliedConfiguration(this.#configuration)
  }

  /**
   * Continue an existing thread instead of creating one.
   *
   * Codex 0.165+ accepts configuration overrides on `thread/resume`. Parameters
   * that are present replace the thread's historical values; absent parameters
   * leave history alone. The response is compared with the requested facts so a
   * caller never mistakes a requested model, cwd, or permission policy for an
   * effective one.
   *
   * The app-server refuses a thread with no rollout yet, so a thread becomes
   * resumable only after it has carried one turn.
   *
   * @param threadId - the thread to continue, as a previous run reported it.
   * @param overrides - explicit model/cwd/permission facts to apply.
   * @param signal - cancellation for an unpublished resume.
   */
  async resumeThread(
    threadId: string,
    overrides: CodexResumeOverrides = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const permission = overrides.permission === undefined
      ? undefined
      : THREAD_PERMISSION_PARAMS[overrides.permission]
    const requested: RequestedConfiguration = {
      ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
      ...(overrides.model === undefined ? {} : { model: overrides.model }),
      ...(permission === undefined ? {} : requestedPermission(permission)),
    }
    const response = object(
      await this.#guarded(
        this.#transport.request('thread/resume', {
          threadId,
          ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
          ...(overrides.model === undefined ? {} : { model: overrides.model }),
          ...(permission ?? {}),
        }, { signal }),
        signal,
      ),
      'thread/resume response',
    )
    // The reply carries the thread, but a thread already known by id is what the
    // caller asked for; the response only has to prove the resume was accepted.
    const resumed = response.thread
    if (resumed !== undefined) {
      const id = string(object(resumed, 'thread/resume thread').id, 'thread/resume thread id')
      if (id !== threadId) throw new Error(`${P}: thread/resume answered for ${id}, not ${threadId}`)
    }
    this.#threadId = threadId
    this.#usage.resetForResume(threadId)
    this.#flushEarlyUsage()
    this.#configuration = appliedConfiguration('thread/resume', requested, response)
    this.#progress(`thread ${threadId} (resumed) configuration matched=${this.#configuration.matched}`)
    requireAppliedConfiguration(this.#configuration)
  }

  /**
   * Give the thread a name.
   *
   * The name is what a person sees in the Codex application's thread list. It
   * matters here because a thread this provider creates has to report itself as
   * `Codex Desktop` to be listed at all, so the name is the only place left to
   * say that the work came from DSH and what it was. Best effort: a thread that
   * ran is worth more than a naming failure, so the caller is told rather than
   * thrown at.
   *
   * @param name - the name to record.
   * @param signal - cancellation for an unpublished request.
   * @returns whether the app-server accepted it.
   */
  async setThreadName(name: string, signal?: AbortSignal): Promise<boolean> {
    if (this.#threadId === undefined) return false
    try {
      await this.#guarded(
        this.#transport.request('thread/name/set', { threadId: this.#threadId, name }, { signal }),
        signal,
      )
      this.#progress(`thread ${this.#threadId} named ${JSON.stringify(name)}`)
      return true
    } catch (error) {
      // Naming is best effort, but a deadline/caller abort is not: swallowing
      // it would let a timed-out startup publish a run after its budget.
      if (signal?.aborted === true) throw error
      return false
    }
  }

  /** The images this run produced, in arrival order. */
  get images(): readonly CodexImage[] {
    return this.#images
  }

  /**
   * Retain the images one completed item carries.
   *
   * `imageView` reports a path rather than bytes: the app-server expects the host
   * that asked for the work to read the file itself, which is exactly what the
   * caller can do. An MCP tool result is the other shape — a computer-use
   * screenshot arrives as an image content block inside it.
   *
   * @param item - one completed item.
   */
  #recordImages(item: Record0): void {
    if (item.type === 'imageView' && typeof item.path === 'string' && item.path !== '') {
      this.#images.push({ path: item.path })
      return
    }
    if (item.type !== 'mcpToolCall') return
    const result = item.result
    if (typeof result !== 'object' || result === null) return
    const content = (result as Record0).content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const image = block as Record0
      if (image.type !== 'image') continue
      if (typeof image.data === 'string' && image.data !== '') {
        this.#images.push({
          data: image.data,
          ...(typeof image.mimeType === 'string' ? { mimeType: image.mimeType } : {}),
        })
      }
    }
  }

  /** The thread this wire is working in, once it has one. */
  get threadId(): string | undefined {
    return this.#threadId
  }

  /** Authoritative turn id, adopted only after the start response agrees. */
  get turnId(): string | undefined {
    return this.#turnId
  }
  /** Conservative request boundary, not inferred from progress or a known PID. */
  get dispatch(): 'not-dispatched' | 'possible' | 'accepted' { return this.#dispatch }

  /** Token usage attributable to this one delegation; never a zero guess. */
  get usageReport(): CodexUsageReport {
    return this.#usage.report()
  }

  /** Account rate limits, kept separate from token usage. */
  get rateLimitsReport(): CodexRateLimitsReport {
    return {
      observations: this.#rateLimitObservations,
      ...(this.#rateLimits === undefined ? {} : { latest: this.#rateLimits }),
    }
  }

  /** The requested and effective configuration of the one start/resume. */
  get configuration(): AppliedConfiguration | undefined {
    return this.#configuration
  }

  get turnConfiguration(): TurnConfiguration | undefined {
    return this.#turnConfiguration
  }

  /**
   * Submit the one text-only task and wait for this thread/turn's terminal
   * notification.
   *
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @param effort - per-turn thinking level, if the caller chose one.
   * @returns the selected output and its stop reason.
   */
  async runTurn(
    texts: readonly TaskText[],
    signal?: AbortSignal,
    effort?: string,
    images: readonly string[] = [],
    outputSchema?: Record0,
    lifecycle?: (stage: 'dispatch-intent' | 'dispatch-possible' | 'turn-accepted') => Promise<void>,
  ): Promise<WireRunResult> {
    const completion = Promise.withResolvers<TurnCompletion>()
    this.#turnCompleted = completion
    const threadId = this.#threadId
    if (threadId === undefined || this.#configuration?.matched !== true) {
      throw new Error(`${P}: cannot start a turn without verified thread configuration`)
    }
    // These are programmatic persistence barriers, never model text or human
    // approval. Mark possible BEFORE writing: a crash after that ACK must stay
    // ambiguous unless a durable terminal receipt can be reconciled.
    if (lifecycle !== undefined) {
      await this.#guarded(lifecycle('dispatch-intent'), signal)
      this.#dispatch = 'possible'
      await this.#guarded(lifecycle('dispatch-possible'), signal)
    }
    this.#dispatch = 'possible'
    this.#usage.startTurnRequest()
    this.#turnConfiguration = {
      ...(effort === undefined ? {} : { requestedEffort: effort }),
      effectiveEffort: null, evidence: 'turn/start-request', accepted: false,
    }
    try {
      const turn = object(
        object(
          await this.#guarded(this.#transport.request('turn/start', {
            threadId,
            // Images first, as `localImage`: the app-server enumerates its own
            // input variants and rejects anything else, and a host path is the
            // one form it takes without the bytes travelling at all.
            input: [
              ...images.map((path) => ({ type: 'localImage', path })),
              ...texts.map((text) => ({ type: 'text', text, text_elements: [] })),
            ],
            // ── this package's addition ──────────────────────────────────────
            // The per-turn thinking level. The official adapter never sends it.
            ...effort === undefined ? {} : { effort },
            // `outputSchema` belongs on the turn: the same field on thread/start
            // is accepted and then silently ignored, measured — the answer came
            // back as prose.
            ...outputSchema === undefined ? {} : { outputSchema },
          }, { signal }), signal),
          'turn/start response',
        ).turn,
        'turn/start turn',
      )
      this.#commitTurnId(string(turn.id, 'turn/start turn id'))
      this.#usage.beginTurn(string(turn.id, 'turn/start turn id'))
      this.#turnConfiguration = { ...this.#turnConfiguration, accepted: true }
      this.#dispatch = 'accepted'
      if (lifecycle !== undefined) await this.#guarded(lifecycle('turn-accepted'), signal)
    } catch (error: unknown) {
      this.#recordFailure({ stage: 'turn-start', category: 'unknown' })
      throw error
    }
    let completed: TurnCompletion
    let terminal: Record0
    try {
      completed = await this.#guarded(completion.promise, signal)
      terminal = object(completed.params.turn, 'turn/completed turn')
    } catch (error: unknown) {
      this.#recordFailure({ stage: 'turn', category: 'unknown' })
      throw error
    }
    const status = terminal.status
    if (status !== 'completed') {
      const parsed = failureInfo(terminal)
      this.#recordFailure(parsed.httpStatus === undefined
        ? { stage: 'turn', category: parsed.category }
        : { stage: 'turn', category: parsed.category, httpStatus: parsed.httpStatus })
      if (parsed.sandboxFailure === true) {
        this.#recordDiagnostic('sandbox execution', 'failed', 'Codex reported a sandbox failure', completed.order)
      }
      if (parsed.maxTokens === true) return { output: this.#collectOutput(), stopReason: 'max-tokens', images: this.images }
      const detail = status === 'failed' ? `: ${parsed.category}` : ''
      throw new Error(`${P}: Codex turn ended with status ${String(status)}${detail}`)
    }
    const output = this.#collectOutput()
    if (output.length === 0) {
      this.#recordFailure({ stage: 'turn', category: 'invalid-result' })
      throw new Error(`${P}: Codex completed without a final answer`)
    }
    return { output, stopReason: 'completed', images: this.images }
  }

  /** The best non-commentary answer observed so far, preserving exact bytes. */
  get partialOutput(): readonly { readonly type: 'text', readonly text: string }[] {
    return this.#collectOutput()
  }

  /**
   * Best-effort remote cancellation. Local settlement and process teardown stay
   * authoritative when the child no longer accepts protocol requests.
   */
  interrupt(): void {
    if (this.#threadId === undefined || this.#turnId === undefined || this.#closed) return
    this.#transport.request('turn/interrupt', { threadId: this.#threadId, turnId: this.#turnId }).catch(() => {})
  }

  /** The latest safe unattended permission fact observed for this run. */
  collectDiagnostic(): string | undefined {
    return this.#diagnostic
  }

  /** The structured failure fact observed for this published turn. */
  collectFailure(): CodexFailureFacts | undefined {
    return this.#failure
  }

  /** Detach listeners and fail outstanding requests. Idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#usage.close()
    this.#transport.dispose(new Error(`${P}: app-server connection closed`))
  }

  /** The best non-commentary answer observed so far, preserving exact bytes. */
  #collectOutput(): { type: 'text'; text: string }[] {
    // Latest final answer wins, then stable partial text (DSH 0.2.1's official
    // adapter selects the same way), then an unphased message for compatibility.
    const selected = this.#lastFinalAnswer ?? this.#lastPartialAnswer ?? this.#lastUnphasedAnswer
    return selected !== undefined && selected.trim().length > 0 ? [{ type: 'text', text: selected }] : []
  }

  /** Race one operation against the connection's fatal failure. */
  async #guarded<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    return raceAbort(Promise.race([this.#fatal.promise as Promise<T>, pending]), signal)
  }

  /** Poison the connection: every guarded operation fails from here on. */
  #fail(error: Error): void {
    this.#fatal.reject(error)
  }

  #onInputError = (error: Error): void => { this.#fail(error) }
  #onOutputError = (error: Error): void => { this.#fail(error) }
  #onInputEnd = (): void => {
    this.#inputEnded = true
    this.#fail(new Error(`${P}: app-server protocol stream closed`))
  }

  /** Record a turn id observed before `turn/start` returned. */
  #observePendingTurnId(id: string): void {
    if (this.#turnCompleted === undefined) throw new Error(`${P}: app-server referenced a turn before turn/start`)
    if (this.#pendingTurnId !== undefined && this.#pendingTurnId !== id) {
      throw new Error(`${P}: app-server referenced conflicting turns`)
    }
    this.#pendingTurnId = id
  }

  /** Adopt the authoritative turn id and replay anything that arrived first. */
  #commitTurnId(id: string): void {
    if (this.#pendingTurnId !== undefined && this.#pendingTurnId !== id) {
      throw new Error(`${P}: turn/start response did not match the active turn`)
    }
    this.#turnId = id
    const pendingDiagnostic = this.#pendingDiagnostic
    this.#pendingDiagnostic = undefined
    if (pendingDiagnostic !== undefined) {
      this.#recordDiagnostic(pendingDiagnostic.request, pendingDiagnostic.decision, pendingDiagnostic.reason, pendingDiagnostic.order)
    }
    const notifications = this.#earlyTurnNotifications.splice(0)
    for (const notification of notifications) this.#handleNotification(notification.method, notification.params, notification.order)
  }

  /**
   * Validate a request's thread and turn association.
   *
   * @param params - the server request's params.
   * @param nullableTurn - whether a null turn id is acceptable.
   * @returns `true` when the matching turn is still provisional.
   */
  #validateRunIds(params: Record0, nullableTurn = false): boolean {
    if (params.threadId !== this.#threadId) throw new Error(`${P}: app-server request referenced another thread`)
    if (nullableTurn && params.turnId === null) return false
    const id = string(params.turnId, 'server request turn id')
    if (this.#turnId === undefined) {
      this.#observePendingTurnId(id)
      return true
    }
    if (id !== this.#turnId) throw new Error(`${P}: app-server request referenced another turn`)
    return false
  }

  /** Record a decision, deferring when its turn is not authoritative yet. */
  #recordRequestDiagnostic(provisional: boolean, request: string, decision: string, reason: string): void {
    const order = this.#nextObservationOrder()
    if (provisional) {
      this.#pendingDiagnostic = { order, request, decision, reason }
      return
    }
    this.#recordDiagnostic(request, decision, reason, order)
  }

  /** Keep the newest diagnostic. */
  #recordDiagnostic(request: string, decision: string, reason: string, order = this.#nextObservationOrder()): void {
    if (order < this.#diagnosticOrder) return
    this.#diagnosticOrder = order
    this.#diagnostic = `Codex unattended decision (mode: ${this.#permissionMode}; request: ${request}; decision: ${decision}): ${reason}`
  }

  #recordFailure(facts: CodexFailureFacts): void {
    this.#failure = facts
  }

  #nextObservationOrder(): number {
    this.#observationOrder += 1
    return this.#observationOrder
  }

  /** Note an item Codex declined, which is a permission fact worth reporting. */
  #recordDeclinedItem(item: Record0, order: number | undefined): boolean {
    if (item.type === 'commandExecution' && item.status === 'declined') {
      this.#recordDiagnostic('command execution', 'declined', 'Codex declined the command under the selected permission mode', order)
      return true
    }
    if (item.type === 'fileChange' && item.status === 'declined') {
      this.#recordDiagnostic('file change', 'declined', 'Codex declined the file change under the selected permission mode', order)
      return true
    }
    return false
  }

  /** Answer every interactive request without a human. */
  #handleServerRequest(method: string, params: unknown): Promise<unknown> {
    try {
      const fields = (params ?? {}) as Record0
      switch (method) {
        case 'item/commandExecution/requestApproval': {
          const provisional = this.#validateRunIds(fields)
          const decision = unattendedDecision(fields)
          this.#recordRequestDiagnostic(provisional, 'command approval', decision === 'cancel' ? 'cancelled' : 'declined', 'the provider does not grant interactive approval')
          return Promise.resolve({ decision })
        }
        case 'item/fileChange/requestApproval': {
          const provisional = this.#validateRunIds(fields)
          const decision = unattendedDecision(fields)
          this.#recordRequestDiagnostic(provisional, 'file approval', decision === 'cancel' ? 'cancelled' : 'declined', 'the provider does not grant interactive approval')
          return Promise.resolve({ decision })
        }
        case 'item/permissions/requestApproval':
          this.#recordRequestDiagnostic(this.#validateRunIds(fields), 'permission grant', 'denied', 'the provider grants no additional turn permissions')
          return Promise.resolve({ permissions: {}, scope: 'turn' })
        case 'item/tool/requestUserInput':
          this.#recordRequestDiagnostic(this.#validateRunIds(fields), 'user input', 'empty response', 'the provider does not collect interactive answers')
          return Promise.resolve({ answers: {} })
        case 'mcpServer/elicitation/request':
          this.#recordRequestDiagnostic(this.#validateRunIds(fields, true), 'MCP elicitation', 'declined', 'the provider does not collect interactive MCP input')
          return Promise.resolve({ action: 'decline', content: null, _meta: null })
        default:
          throw new Error(`${P}: unsupported app-server request ${JSON.stringify(method)}`)
      }
    } catch (error: unknown) {
      const normalized = thrown(error)
      this.#fail(normalized)
      return Promise.reject(normalized)
    }
  }

  /** Replay usage notifications that raced the start/resume response. */
  #flushEarlyUsage(): void {
    if (this.#threadId === undefined) return
    if (this.#earlyUsageOverflow) this.#usage.observeInvalid()
    const pending = this.#earlyUsageNotifications.splice(0)
    for (const notification of pending) {
      if (typeof notification.threadId !== 'string' || notification.threadId === '') {
        this.#usage.observeInvalid()
        continue
      }
      if (notification.threadId !== this.#threadId) continue
      const tokenUsage = notification.tokenUsage
      if (typeof tokenUsage !== 'object' || tokenUsage === null || Array.isArray(tokenUsage)) {
        this.#usage.observeInvalid()
        continue
      }
      this.#usage.observe(notification)
    }
  }

  /** Route one notification, buffering anything that precedes the turn id. */
  #handleNotification(method: string, params: unknown, order?: number): void {
    const fields = (params ?? {}) as Record0
    if (method === 'thread/tokenUsage/updated') {
      if (this.#threadId === undefined) {
        if (this.#earlyUsageNotifications.length < 128) {
          this.#earlyUsageNotifications.push({
            threadId: fields.threadId,
            turnId: fields.turnId,
            tokenUsage: fields.tokenUsage,
          })
        } else this.#earlyUsageOverflow = true
        return
      }
      if (typeof fields.threadId !== 'string' || fields.threadId === '') {
        this.#usage.observeInvalid()
        return
      }
      if (fields.threadId !== this.#threadId) return
      const tokenUsage = fields.tokenUsage
      if (typeof tokenUsage !== 'object' || tokenUsage === null || Array.isArray(tokenUsage)) {
        this.#usage.observeInvalid()
        return
      }
      this.#usage.observe({
        threadId: fields.threadId,
        turnId: fields.turnId,
        tokenUsage,
      })
      return
    }
    if (method === 'account/rateLimits/updated') {
      const rateLimits = fields.rateLimits
      if (typeof rateLimits !== 'object' || rateLimits === null || Array.isArray(rateLimits)) return
      this.#rateLimits = rateLimits as Record<string, unknown>
      this.#rateLimitObservations += 1
      return
    }
    if (method === 'turn/started') {
      if (string(fields.threadId, 'turn/started thread id') !== this.#threadId) return
      const turn = object(fields.turn, 'turn/started turn')
      if (this.#turnCompleted !== undefined && this.#turnId === undefined) {
        this.#observePendingTurnId(string(turn.id, 'turn/started turn id'))
      }
      return
    }
    if (method === 'item/completed') {
      if (string(fields.threadId, 'item/completed thread id') !== this.#threadId) return
      const id = string(fields.turnId, 'item/completed turn id')
      if (this.#turnId === undefined) {
        if (this.#turnCompleted !== undefined) {
          this.#observePendingTurnId(id)
          this.#earlyTurnNotifications.push({ method, params, order: this.#nextObservationOrder() })
        }
        return
      }
      if (id !== this.#turnId) return
      const item = object(fields.item, 'item/completed item')
      if (this.#recordDeclinedItem(item, order)) return
      this.#recordImages(item)
      if (item.type !== 'agentMessage') {
        // Commands, file changes, and searches: the interesting part of a long run.
        this.#progress(describeItem(item))
        return
      }
      const text = typeof item.text === 'string'
        ? item.text
        : (() => { throw new Error(`${P}: app-server returned an invalid agent message`) })()
      if (item.phase === 'final_answer') this.#lastFinalAnswer = text
      else if (item.phase === 'partial_answer') this.#lastPartialAnswer = text
      else if (item.phase === null) this.#lastUnphasedAnswer = text
      else if (item.phase === 'commentary') this.#progress(text)
      else {
        throw new Error(`${P}: app-server returned an unknown agent message phase ${JSON.stringify(item.phase)}`)
      }
      return
    }
    if (method !== 'turn/completed') return
    if (string(fields.threadId, 'turn/completed thread id') !== this.#threadId) return
    const turn = object(fields.turn, 'turn/completed turn')
    const id = string(turn.id, 'turn/completed turn id')
    const turnCompleted = this.#turnCompleted
    if (turnCompleted === undefined) return
    if (this.#turnId === undefined) {
      this.#observePendingTurnId(id)
      this.#earlyTurnNotifications.push({ method, params, order: this.#nextObservationOrder() })
      return
    }
    if (id !== this.#turnId) return
    this.#terminalObserved = true
    if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) {
      throw new Error(`${P}: app-server returned invalid terminal turn status ${String(turn.status)}`)
    }
    turnCompleted.resolve({ params: params as { turn: unknown }, order: order ?? this.#nextObservationOrder() })
  }
}

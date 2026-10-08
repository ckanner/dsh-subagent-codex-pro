/**
 * Codex app-server protocol adapter.
 *
 * A faithful port of `@deepseek-ai/dsh-subagent-codex`'s wire module, with one
 * substantive addition: it can send a **reasoning effort**. That is the whole
 * reason this package exists. The Codex protocol accepts `reasoningEffort` on
 * `thread/start` and `effort` on `turn/start`; the official adapter sends
 * neither, and the two literals do not appear anywhere in its 871 lines.
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
 * - `reasoningEffort` is threaded through the constructor, and `effort` through
 *   `runTurn`.
 *
 * @module dsh-subagent-codex-pro/wire
 */

import type { LineTransport } from './jsonrpc.ts'

/** Prefix on every error this module raises. */
const P = 'codex-pro'

/** Thread permission params per configured mode; copied verbatim. */
const THREAD_PERMISSION_PARAMS = {
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

/** The configured permission mode. */
export type CodexPermissionMode = keyof typeof THREAD_PERMISSION_PARAMS

/** The stop reasons one run can end with. */
export type CodexStopReason = 'completed' | 'max-tokens' | 'error' | 'aborted'

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
async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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
 * One app-server connection and its single ephemeral thread/turn.
 *
 * Deliberately exposes no generic request surface: supporting another product
 * method must first become part of the provider contract.
 */
export class CodexAppServerWire {
  #permissionMode: CodexPermissionMode
  #model: string | undefined
  /** Sent as `thread/start`'s `reasoningEffort`. Absent from the official adapter. */
  #reasoningEffort: string | undefined
  #transport: LineTransport
  #fatal = Promise.withResolvers<never>()
  #threadId: string | undefined
  #turnId: string | undefined
  #pendingTurnId: string | undefined
  #turnCompleted: { promise: Promise<TurnCompletion>; resolve: (value: TurnCompletion) => void } | undefined
  #earlyTurnNotifications: { method: string; params: unknown; order: number }[] = []
  #lastFinalAnswer: string | undefined
  #lastUnphasedAnswer: string | undefined
  #diagnostic: string | undefined
  #failure: CodexFailureFacts | undefined
  #diagnosticOrder = 0
  #observationOrder = 0
  #pendingDiagnostic: { order: number; request: string; decision: string; reason: string } | undefined
  #inputEnded = false
  #terminalObserved = false
  #closed = false
  /** Narrates notable events, for a caller that reports progress. */
  #onProgress: ((text: string) => void) | undefined

  constructor(
    input: WireInput,
    output: WireOutput,
    transport: LineTransport,
    permissionMode: CodexPermissionMode,
    model: string | undefined,
    reasoningEffort: string | undefined,
  ) {
    this.#permissionMode = permissionMode
    this.#model = model
    this.#reasoningEffort = reasoningEffort
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
          clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
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
   * Create the run's private ephemeral thread and retain its identity.
   *
   * @param cwd - the parent session's workspace.
   * @param signal - cancellation for an unpublished start.
   */
  async startThread(cwd: string, signal?: AbortSignal): Promise<void> {
    const thread = object(
      object(
        await this.#guarded(this.#transport.request('thread/start', {
          cwd,
          ephemeral: true,
          ...this.#model === undefined ? {} : { model: this.#model },
          // ── this package's addition ────────────────────────────────────────
          // The model's default thinking level for the thread. The official
          // adapter never sends this field.
          ...this.#reasoningEffort === undefined ? {} : { reasoningEffort: this.#reasoningEffort },
          ...THREAD_PERMISSION_PARAMS[this.#permissionMode],
        }, { signal }), signal),
        'thread/start response',
      ).thread,
      'thread/start thread',
    )
    const id = string(thread.id, 'thread/start thread id')
    if (thread.ephemeral !== true) throw new Error(`${P}: app-server did not create an ephemeral thread`)
    this.#threadId = id
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
  async runTurn(texts: readonly TaskText[], signal?: AbortSignal, effort?: string): Promise<WireRunResult> {
    const completion = Promise.withResolvers<TurnCompletion>()
    this.#turnCompleted = completion
    const threadId = this.#threadId
    try {
      const turn = object(
        object(
          await this.#guarded(this.#transport.request('turn/start', {
            threadId,
            input: texts.map((text) => ({ type: 'text', text, text_elements: [] })),
            // ── this package's addition ──────────────────────────────────────
            // The per-turn thinking level. The official adapter never sends it.
            ...effort === undefined ? {} : { effort },
          }, { signal }), signal),
          'turn/start response',
        ).turn,
        'turn/start turn',
      )
      this.#commitTurnId(string(turn.id, 'turn/start turn id'))
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
      if (parsed.maxTokens === true) return { output: this.#collectOutput(), stopReason: 'max-tokens' }
      const detail = status === 'failed' ? `: ${parsed.category}` : ''
      throw new Error(`${P}: Codex turn ended with status ${String(status)}${detail}`)
    }
    const output = this.#collectOutput()
    if (output.length === 0) {
      this.#recordFailure({ stage: 'turn', category: 'invalid-result' })
      throw new Error(`${P}: Codex completed without a final answer`)
    }
    return { output, stopReason: 'completed' }
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
    this.#transport.dispose(new Error(`${P}: app-server connection closed`))
  }

  /** The best non-commentary answer observed so far, preserving exact bytes. */
  #collectOutput(): { type: 'text'; text: string }[] {
    const selected = this.#lastFinalAnswer ?? this.#lastUnphasedAnswer
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

  /** Route one notification, buffering anything that precedes the turn id. */
  #handleNotification(method: string, params: unknown, order?: number): void {
    const fields = (params ?? {}) as Record0
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
      if (item.type !== 'agentMessage') {
        // Commands, file changes, and searches: the interesting part of a long run.
        this.#progress(describeItem(item))
        return
      }
      const text = typeof item.text === 'string'
        ? item.text
        : (() => { throw new Error(`${P}: app-server returned an invalid agent message`) })()
      if (item.phase === 'final_answer') this.#lastFinalAnswer = text
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

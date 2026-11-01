/**
 * One-shot Codex child lifecycle over the real app-server.
 *
 * The run has one deadline from before startup through the terminal turn. Every
 * startup RPC (initialize, thread/start, thread/resume, thread/name/set) and the
 * turn use the same derived abort signal, so a server that stops answering
 * cannot keep a delegation alive past its budget. Cleanup is a separate, finite
 * grace: the deadline ends work, the grace ends the process range.
 *
 * The child is spawned as the leader of its own POSIX process group. Termination
 * targets the group and then proves it is gone; a descendant that ignores
 * SIGTERM or outlives its parent is reported instead of being silently assumed
 * dead.
 *
 * @module dsh-subagent-codex-pro/run
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { LineTransport, type JsonRpcMessage } from './jsonrpc.ts'
import { verifyStructuredOutput } from './structured.ts'
import {
  CodexAppServerWire,
  DEFAULT_ORIGINATOR,
  type AppliedConfiguration,
  type CodexPermissionMode,
  type CodexRateLimitsReport,
  type CodexResumeOverrides,
  type CodexStopReason,
} from './wire.ts'
import type { CodexImage, CodexThreadMode } from './wire.ts'
import type { CodexUsageReport } from './usage.ts'

/** Default grace between termination tiers. */
const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Hard upper bound on observing a process group disappear after SIGKILL. */
const GROUP_REAP_TIMEOUT_MS = 2_000

/** The task text blocks a run accepts. */
export type PromptBlocks = readonly { readonly type: string; readonly text?: string }[]

/** What happened to the process range at cleanup. */
export interface CleanupReport {
  /** Whether the whole owned process group is confirmed gone. */
  readonly confirmed: boolean
  /** Why confirmation was impossible, when it was. */
  readonly detail?: string
}

/** Everything one run needs that does not change between attempts. */
export interface CodexRunSpec {
  /** The delegating session's working directory. */
  readonly cwd: string
  /** The Codex executable. */
  readonly command: string
  /** Unattended permission policy. */
  readonly permissionMode: CodexPermissionMode
  /** Model requested for this run, when one was chosen. */
  readonly model?: string | undefined
  /**
   * Per-turn thinking level.
   *
   * Codex carries a thinking level on `turn/start`, not on `thread/start`; the
   * latter is not part of the 0.165/0.166 start parameters. `effort` wins when
   * both are supplied.
   */
  readonly effort?: string | undefined
  /** Backwards-compatible alias for `effort`; never sent as a thread default. */
  readonly reasoningEffort?: string | undefined
  /** How long the thread lives. Defaults to `ephemeral`. */
  readonly threadMode?: CodexThreadMode | undefined
  /**
   * Continue this thread instead of creating one.
   *
   * A thread is resumable only once it has carried a turn, so the caller owns
   * remembering an id it was given earlier.
   */
  readonly resumeThreadId?: string | undefined
  /** What the app-server records as the thread's originator. */
  readonly originator?: string | undefined
  /**
   * Deadline for the whole delegation in milliseconds.
   *
   * `0` disables it. Defaults to {@link DEFAULT_RUN_TIMEOUT_MS}.
   */
  readonly runTimeoutMs?: number | undefined
  /**
   * Absolute deadline shared by an auto-resume retry.
   *
   * Internal: the caller computes this once and passes it to both attempts, so
   * creating a new thread after a failed resume cannot borrow a fresh timeout.
   */
  readonly deadlineAt?: number | undefined
  /**
   * Absolute paths of images to put in front of Codex with the task.
   *
   * The app-server takes these as `localImage` blocks, so the picture reaches the
   * model as a picture and no bytes travel through the protocol.
   */
  readonly images?: readonly string[] | undefined
  /**
   * A JSON Schema for the final answer.
   *
   * The app-server enforces it, so the answer arrives as JSON that conforms
   * instead of prose a caller has to parse and hope about. Sent on the turn.
   */
  readonly outputSchema?: Record<string, unknown> | undefined
  /**
   * A name for a persistent thread, shown in the Codex application's thread list.
   *
   * Ignored for `ephemeral`: a thread that leaves nothing behind has no list to
   * appear in.
   */
  readonly threadName?: string | undefined
  /** Extra environment entries. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Grace between termination tiers. */
  readonly disposeGraceMs?: number | undefined
  /** Narrates notable child activity, for a caller that reports progress. */
  readonly onProgress?: ((text: string) => void) | undefined
}

/** What one finished run reports. */
export interface CodexRunOutcome {
  readonly output: readonly { readonly type: 'text'; readonly text: string }[]
  readonly stopReason: CodexStopReason
  readonly diagnostic?: string
  /**
   * The thread this run used.
   *
   * Reported for every outcome, including a failed one: a persistent thread that
   * half-ran is still a thread the user may want to open or clean up, and it is
   * the only handle `resumeThreadId` accepts.
   */
  readonly threadId?: string | undefined
  /**
   * Images the run produced.
   *
   * Reported even on a failed run: a screenshot taken before the failure is
   * still a screenshot the user asked for.
   */
  readonly images?: readonly CodexImage[] | undefined
  /** Token usage attributable to this run; `unknown` rather than zero when absent. */
  readonly usage: CodexUsageReport
  /** Account rate limits, deliberately separate from token usage. */
  readonly rateLimits: CodexRateLimitsReport
  /** Requested vs effective model/cwd/permission facts, when startup got that far. */
  readonly configuration?: AppliedConfiguration | undefined
  /** Whether the process range is confirmed gone. */
  readonly cleanup: CleanupReport
  /** Parsed structured result, only when a schema was supplied and verification passed. */
  readonly structured?: unknown
  /** Why structured verification failed, when it did. */
  readonly schemaError?: string
}

/** The published run. */
export interface StartedCodexRun {
  /** A durable id for the harness's catalog. */
  readonly id: string
  /** Never rejects: a failure arrives as a stop reason plus a diagnostic. */
  readonly result: Promise<CodexRunOutcome>
  /** Ask the child to stop; local settlement stays authoritative. */
  requestCancel(): void
  /** Release the process range. Idempotent, and awaited by the caller. */
  teardown(): Promise<CleanupReport>
}

/** A spawned process plus the lifecycle operations the run needs. */
interface ManagedChild {
  readonly proc: ChildProcessWithoutNullStreams
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  terminate(graceMs: number): Promise<CleanupReport>
  waitForExit(timeoutMs: number): Promise<boolean>
}

/**
 * How long one delegation may take before it is cancelled.
 *
 * A delegation that hangs is invisible: the job stays `running`, nothing is
 * logged, and the session waits. The deadline turns that into a failure with a
 * reason. Ten minutes is generous against a package whose own README says a
 * delegation takes "a minute or more", and `0` disables it.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000

/** The failure taxonomy carried out of a run. */
interface FailureFacts {
  readonly stage: string
  readonly category: string
  readonly httpStatus?: number
}

/** A run failure, kept for its structured facts and any cleanup it observed. */
export class CodexRunFailure extends Error {
  readonly facts: FailureFacts
  readonly cleanup: CleanupReport | undefined

  constructor(facts: FailureFacts, cause?: unknown, cleanup?: CleanupReport) {
    const cleanupDetail = cleanup?.confirmed === false
      ? `; process cleanup unconfirmed${cleanup.detail === undefined ? '' : `: ${cleanup.detail}`}`
      : ''
    super(`codex-pro: product subagent failure (${describeFacts(facts)})${cleanupDetail}`,
      cause === undefined ? undefined : { cause })
    this.facts = facts
    this.cleanup = cleanup
    this.name = 'CodexRunFailure'
  }
}

/** The diagnostic for a delegation the deadline stopped. */
export function describeTimeout(timeoutMs: number): string {
  return `codex-pro: the delegation exceeded its ${String(timeoutMs)} ms deadline and was cancelled`
}

/** Render failure facts for a diagnostic string. */
function describeFacts(facts: FailureFacts): string {
  const fields = ['product: Codex', `stage: ${facts.stage}`, `category: ${facts.category}`]
  if (facts.httpStatus !== undefined) fields.push(`HTTP status: ${facts.httpStatus}`)
  return fields.join('; ')
}

/** Normalise an unknown throwable. */
function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** A short non-throwing delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 *
 * @param prompt - the delegation's content blocks.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: PromptBlocks): string[] {
  if (prompt.length === 0) throw new Error('codex-pro: a delegation prompt must be text; images reach Codex through the '
      + '`images` parameter, which takes absolute paths')
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('codex-pro: a delegation prompt must be text; images reach Codex through the '
      + '`images` parameter, which takes absolute paths')
    }
    texts.push(block.text)
  }
  if (texts.every((text) => text.trim().length === 0)) {
    throw new Error('codex-pro: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Spawn the app-server and wrap its lifecycle.
 *
 * The child is detached into its own process group on POSIX so termination can
 * target everything the delegation owns without a global `killall`. Termination
 * is idempotent and resolves with a confirmation report rather than assuming
 * that a signal is the same thing as a dead process.
 *
 * @param spec - the executable, working directory, and environment.
 * @returns the managed child.
 */
function spawnAppServer(spec: CodexRunSpec): ManagedChild {
  const posix = process.platform !== 'win32'
  const proc = spawn(spec.command, ['app-server', '--stdio'], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: posix,
    windowsHide: true,
  })
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
  })
  // A spawn error is delivered as a rejection; observe it even when the caller
  // races it elsewhere so it can never become an unhandled rejection.
  done.catch(() => {})

  const groupPid = posix ? proc.pid : undefined
  let termination: Promise<CleanupReport> | undefined

  const groupAlive = (): boolean => {
    if (groupPid !== undefined) {
      try {
        process.kill(-groupPid, 0)
        return true
      } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    return proc.exitCode === null && proc.signalCode === null
  }

  const sendSignal = (signal: NodeJS.Signals): void => {
    try {
      if (groupPid !== undefined) process.kill(-groupPid, signal)
      else proc.kill(signal)
    } catch {
      // ESRCH: the range is already gone. Other failures are reported by the
      // final liveness check rather than thrown out of cleanup.
    }
  }

  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    const exited = done.then(() => true, () => true)
    if (timeoutMs <= 0) {
      // A zero wait still observes an already-settled process.
      return Promise.race([exited, Promise.resolve(false)])
    }
    return Promise.race([
      exited,
      delay(timeoutMs).then(() => false),
    ])
  }

  const terminate = (graceMs: number): Promise<CleanupReport> => {
    if (termination !== undefined) return termination
    termination = (async (): Promise<CleanupReport> => {
      if (proc.pid === undefined) {
        // No OS process was created (for example, ENOENT); there is no owned
        // range to leave behind.
        return { confirmed: true }
      }
      sendSignal('SIGTERM')
      await waitForExit(graceMs)
      if (groupAlive()) {
        sendSignal('SIGKILL')
        await waitForExit(Math.min(Math.max(graceMs, 250), GROUP_REAP_TIMEOUT_MS))
      }
      const until = Date.now() + GROUP_REAP_TIMEOUT_MS
      while (groupAlive() && Date.now() < until) await delay(25)
      return groupAlive()
        ? { confirmed: false, detail: 'the owned process group was still alive after SIGKILL' }
        : { confirmed: true }
    })()
    return termination
  }

  return { proc, done, terminate, waitForExit }
}

/** Build the argv, for diagnostics and tests. */
export function codexAppServerArgv(command: string): string[] {
  return [command, 'app-server', '--stdio']
}

/** Build one failure for an unpublished startup. */
function startupFailure(
  stage: string,
  error: unknown,
  flags: { readonly timedOut: boolean, readonly callerAborted: boolean },
  cleanup: CleanupReport,
): CodexRunFailure {
  if (error instanceof CodexRunFailure) {
    return new CodexRunFailure(error.facts, error.cause, cleanup)
  }
  const category = flags.timedOut
    ? 'timeout'
    : flags.callerAborted
      ? 'aborted'
      : stage === 'process'
        ? 'process'
        : 'protocol'
  return new CodexRunFailure({ stage, category }, error, cleanup)
}

/**
 * Start the app-server child and publish its one-shot run.
 *
 * Resolves only after initialization and thread creation/resume, so a failure
 * before that point rejects with no run published. After publication the result
 * never rejects; even a failed run carries its observed usage, images, thread,
 * configuration, and cleanup report.
 *
 * @param prompt - the delegation's content blocks.
 * @param spec - working directory, executable, permission mode, and choices.
 * @param signal - caller cancellation.
 * @returns the published run.
 */
export async function startCodexRun(
  prompt: PromptBlocks,
  spec: CodexRunSpec,
  signal: AbortSignal,
): Promise<StartedCodexRun> {
  const texts = textTask(prompt)
  if (signal.aborted) throw new CodexRunFailure({ stage: 'initialize', category: 'aborted' })

  const graceMs = spec.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  const startedAt = Date.now()
  const requestedTimeout = spec.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const deadlineAt = spec.deadlineAt
    ?? (requestedTimeout > 0 ? startedAt + requestedTimeout : undefined)
  const timeoutDescriptionMs = deadlineAt === undefined ? requestedTimeout : Math.max(1, deadlineAt - startedAt)

  let child: ManagedChild
  try {
    child = spawnAppServer(spec)
  } catch (error: unknown) {
    throw new CodexRunFailure({ stage: 'initialize', category: 'process' }, error)
  }

  const transport = new LineTransport(child.proc.stdin, child.proc.stdout)
  const wire = new CodexAppServerWire(
    child.proc.stdout,
    child.proc.stdin,
    transport,
    {
      permissionMode: spec.permissionMode,
      model: spec.model,
      threadMode: spec.threadMode,
      originator: spec.originator ?? DEFAULT_ORIGINATOR,
    },
  )
  if (spec.onProgress !== undefined) wire.setProgressReporter(spec.onProgress)
  const forwardStderr = (chunk: Buffer | string): void => {
    try {
      process.stderr.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    } catch {
      // Diagnostics must never take the run down.
    }
  }
  child.proc.stderr.on('data', forwardStderr)

  const runAbort = new AbortController()
  let timedOut = false
  let callerAborted = false
  let timer: NodeJS.Timeout | undefined
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('codex-pro: run cancelled locally'))
    wire.interrupt()
  }
  const onCallerAbort = (): void => {
    callerAborted = true
    requestCancel()
  }
  if (deadlineAt !== undefined) {
    timer = setTimeout(() => {
      timedOut = true
      requestCancel()
    }, Math.max(0, deadlineAt - Date.now()))
    timer.unref?.()
  }
  signal.addEventListener('abort', onCallerAbort, { once: true })
  // A signal that aborted between the pre-spawn check and this listener would
  // otherwise never deliver its event; the run must still observe it.
  if (signal.aborted) onCallerAbort()

  const teardown = async (): Promise<CleanupReport> => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    signal.removeEventListener('abort', onCallerAbort)
    wire.close()
    try { child.proc.stdin.end() } catch { /* already closed */ }
    const cleanup = await child.terminate(graceMs)
    child.proc.stderr.off('data', forwardStderr)
    return cleanup
  }
  let tornDown: Promise<CleanupReport> | undefined
  const teardownOnce = (): Promise<CleanupReport> => (tornDown ??= teardown())

  let processFailureFacts: FailureFacts | undefined
  const processFailure = child.done.then(
    () => {
      processFailureFacts = { stage: 'process', category: 'process' }
      throw new CodexRunFailure(processFailureFacts)
    },
    (error: unknown) => {
      processFailureFacts = { stage: 'process', category: 'process' }
      throw new CodexRunFailure(processFailureFacts, error)
    },
  )
  processFailure.catch(() => {})

  let startupStage = 'initialize'
  try {
    await Promise.race([wire.initialize(runAbort.signal), processFailure])
    if (spec.resumeThreadId === undefined) {
      startupStage = 'thread-start'
      await Promise.race([wire.startThread(spec.cwd, runAbort.signal), processFailure])
    } else {
      startupStage = 'thread-resume'
      const overrides: CodexResumeOverrides = {
        cwd: spec.cwd,
        ...(spec.model === undefined ? {} : { model: spec.model }),
        permission: spec.permissionMode,
      }
      await Promise.race([wire.resumeThread(spec.resumeThreadId, overrides, runAbort.signal), processFailure])
    }
    // A persistent thread is named so the Codex application's list says where it
    // came from; the id alone cannot, because the originator has to be the value
    // that client filters on.
    if (spec.threadMode === 'persistent' && spec.threadName !== undefined) {
      startupStage = 'thread-name'
      await Promise.race([wire.setThreadName(spec.threadName, runAbort.signal), processFailure])
    }
  } catch (error: unknown) {
    const cleanup = await teardownOnce()
    throw startupFailure(
      processFailureFacts === undefined ? startupStage : 'process',
      error,
      { timedOut, callerAborted },
      cleanup,
    )
  }

  const finish = async (
    turn: { readonly output: readonly { readonly type: 'text', readonly text: string }[],
      readonly stopReason: CodexStopReason, readonly images: readonly CodexImage[] } | undefined,
    error: unknown,
  ): Promise<CodexRunOutcome> => {
    const cleanup = await teardownOnce()
    const usage = wire.usageReport
    const rateLimits = wire.rateLimitsReport
    const configuration = wire.configuration
    const observedImages = turn?.images ?? wire.images
    let output = turn?.output ?? wire.partialOutput
    let stopReason: CodexStopReason = turn?.stopReason
      ?? (timedOut ? 'timeout' : callerAborted || runAbort.signal.aborted ? 'aborted' : 'error')
    let diagnostic = wire.collectDiagnostic()
    let structured: unknown
    let schemaError: string | undefined

    if (spec.outputSchema !== undefined && stopReason === 'completed') {
      const text = output.map((block) => block.text).join('\n\n')
      const verification = verifyStructuredOutput(text, spec.outputSchema)
      if (verification.ok) {
        structured = verification.value
      } else {
        schemaError = verification.error
        // A schema was requested: an unparseable or invalid answer is not a
        // structured success. Preserve the raw output and say why it failed.
        if (stopReason === 'completed') stopReason = 'error'
        diagnostic = diagnostic === undefined ? schemaError : `${diagnostic}; ${schemaError}`
      }
    }

    if (!cleanup.confirmed) {
      const cleanupDetail = `process cleanup could not be confirmed${cleanup.detail === undefined ? '' : `: ${cleanup.detail}`}`
      diagnostic = diagnostic === undefined ? cleanupDetail : `${diagnostic}; ${cleanupDetail}`
    }
    if (timedOut) {
      const timeoutDetail = describeTimeout(timeoutDescriptionMs)
      diagnostic = diagnostic === undefined ? timeoutDetail : `${diagnostic}; ${timeoutDetail}`
    } else if (callerAborted) {
      const abortDetail = 'codex-pro: the delegation was cancelled by its caller'
      diagnostic = diagnostic === undefined ? abortDetail : `${diagnostic}; ${abortDetail}`
    } else if (error !== undefined && diagnostic === undefined) {
      diagnostic = error instanceof Error ? error.message : String(error)
    } else if (error !== undefined && !(error instanceof CodexRunFailure)) {
      diagnostic = `${diagnostic}; ${error instanceof Error ? error.message : String(error)}`
    }

    return {
      output,
      stopReason,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      threadId: wire.threadId,
      images: observedImages,
      usage,
      rateLimits,
      ...(configuration === undefined ? {} : { configuration }),
      cleanup,
      ...(structured === undefined ? {} : { structured }),
      ...(schemaError === undefined ? {} : { schemaError }),
    }
  }

  const result = (async (): Promise<CodexRunOutcome> => {
    try {
      const turn = await Promise.race([
        wire.runTurn(
          texts,
          runAbort.signal,
          spec.effort ?? spec.reasoningEffort,
          spec.images ?? [],
          spec.outputSchema,
        ),
        processFailure,
      ])
      return await finish(turn, undefined)
    } catch (error: unknown) {
      return await finish(undefined, error)
    }
  })()

  return {
    id: randomUUID(),
    result,
    requestCancel,
    teardown: teardownOnce,
  }
}

/** The message shapes the wire exchanges, re-exported for diagnostics. */
export type { JsonRpcMessage }

/** Which thread a call should continue, if any. */
export interface ThreadChoice {
  /** The thread to continue, or `undefined` to start a fresh one. */
  readonly reuse: string | undefined
  /**
   * The remembered thread this call wanted but found busy.
   *
   * Reported rather than dropped: the call still runs, in its own thread, and a
   * log line is the only way to know the session's thread was skipped.
   */
  readonly skippedBusy: string | undefined
}

/**
 * Decide which thread one call continues.
 *
 * `session` mode has one thread per Agent session, but a thread carries one turn
 * at a time: two delegations sent together would otherwise both reach for it and
 * the second would fail. A remembered thread that another delegation is already
 * using is therefore skipped, and this call gets a thread of its own — which is
 * what `persistent` does anyway, so parallel work degrades to the mode that
 * supports it instead of failing and retrying.
 *
 * An id the caller passed explicitly is never skipped: continuing *that* thread
 * was the request, and silently running somewhere else would answer a different
 * question.
 *
 * @param input - the call's explicit id, the configured mode, the session's
 * remembered thread, and the threads currently in flight.
 * @returns the thread to continue and the remembered one that was busy.
 */
export function chooseThread(input: {
  readonly explicit: string | undefined
  readonly configured: 'ephemeral' | 'persistent' | 'session'
  readonly remembered: string | undefined
  readonly inFlight: ReadonlySet<string>
}): ThreadChoice {
  if (input.explicit !== undefined) return { reuse: input.explicit, skippedBusy: undefined }
  if (input.configured !== 'session' || input.remembered === undefined) {
    return { reuse: undefined, skippedBusy: undefined }
  }
  if (input.inFlight.has(input.remembered)) {
    return { reuse: undefined, skippedBusy: input.remembered }
  }
  return { reuse: input.remembered, skippedBusy: undefined }
}

/**
 * A delegation that did not complete.
 *
 * Carries the thread, images, and (when publication reached the run) the whole
 * outcome, so a caller can report observed usage even though the run failed.
 */
export class CodexDelegationFailure extends Error {
  /** The thread the failed run used, when the app-server had got that far. */
  readonly threadId: string | undefined
  /** Images the failed run produced before it failed. */
  readonly images: readonly CodexImage[]
  /** Everything observed about the failed run, when one was published. */
  readonly outcome: CodexRunOutcome | undefined

  constructor(
    message: string,
    threadId: string | undefined,
    images: readonly CodexImage[] = [],
    outcome?: CodexRunOutcome,
  ) {
    super(message)
    this.name = 'CodexDelegationFailure'
    this.threadId = threadId
    this.images = images
    this.outcome = outcome
  }
}

/** The successful result of `delegateOnce`, with the observability fields intact. */
export interface DelegatedCodexRun {
  readonly text: string
  readonly threadId: string | undefined
  readonly images: readonly CodexImage[]
  readonly usage: CodexUsageReport
  readonly rateLimits: CodexRateLimitsReport
  readonly configuration?: AppliedConfiguration
  readonly cleanup: CleanupReport
  readonly structured?: unknown
}

/** Run one delegation and return its settled outcome. */
export async function runCodexOnce(
  options: {
    readonly prompt: string
    readonly cwd: string
    readonly command: string
    readonly permissionMode: CodexPermissionMode
    readonly model?: string | undefined
    readonly reasoningEffort?: string | undefined
    readonly threadMode?: CodexThreadMode | undefined
    readonly threadId?: string | undefined
    readonly originator?: string | undefined
    readonly threadName?: string | undefined
    readonly runTimeoutMs?: number | undefined
    /** Absolute deadline shared with an auto-resume retry. */
    readonly deadlineAt?: number | undefined
    readonly images?: readonly string[] | undefined
    readonly outputSchema?: Record<string, unknown> | undefined
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly signal: AbortSignal
    readonly onStart?: ((id: string) => void) | undefined
    readonly onProgress?: ((text: string) => void) | undefined
  },
): Promise<CodexRunOutcome> {
  const run = await startCodexRun(
    [{ type: 'text', text: options.prompt }],
    {
      cwd: options.cwd,
      command: options.command,
      permissionMode: options.permissionMode,
      model: options.model,
      effort: options.reasoningEffort,
      threadMode: options.threadMode,
      resumeThreadId: options.threadId,
      originator: options.originator,
      runTimeoutMs: options.runTimeoutMs,
      ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
      images: options.images,
      outputSchema: options.outputSchema,
      threadName: options.threadName,
      env: options.env,
      onProgress: options.onProgress,
    },
    options.signal,
  )
  options.onStart?.(run.id)
  try {
    return await run.result
  } finally {
    await run.teardown()
  }
}

/**
 * Run one delegation to completion and return its final text.
 *
 * The result keeps the thread, images, usage, configuration and cleanup report
 * available to callers that need to report more than the answer. A run that
 * does not complete rejects with the whole outcome attached.
 *
 * @param options - the task, its working directory, and the choices.
 * @returns the child's final message and its observability fields.
 * @throws `CodexDelegationFailure` when the run does not complete.
 */
export async function delegateOnce(options: {
  readonly prompt: string
  readonly cwd: string
  readonly command: string
  readonly permissionMode: CodexPermissionMode
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
  /** How long the thread lives. Defaults to `ephemeral`. */
  readonly threadMode?: CodexThreadMode | undefined
  /** Continue this thread instead of creating one. */
  readonly threadId?: string | undefined
  /** What the app-server records as the thread's originator. */
  readonly originator?: string | undefined
  /** A name for a persistent thread, shown in the Codex application. */
  readonly threadName?: string | undefined
  /** Deadline for the whole delegation in milliseconds; `0` disables it. */
  readonly runTimeoutMs?: number | undefined
  /** Absolute deadline shared with an auto-resume retry. */
  readonly deadlineAt?: number | undefined
  /** Absolute paths of images to show Codex alongside the task. */
  readonly images?: readonly string[] | undefined
  /** A JSON Schema the final answer must conform to. */
  readonly outputSchema?: Record<string, unknown> | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly signal: AbortSignal
  /** Called once the run is published, for diagnostics. */
  readonly onStart?: (id: string) => void
  /** Narrates notable child activity. */
  readonly onProgress?: ((text: string) => void) | undefined
}): Promise<DelegatedCodexRun> {
  const outcome = await runCodexOnce(options)
  const text = outcome.output.map((block) => block.text).join('\n\n')
  if (
    outcome.stopReason !== 'completed'
    || text === ''
    || outcome.schemaError !== undefined
    || !outcome.cleanup.confirmed
  ) {
    throw new CodexDelegationFailure(
      outcome.diagnostic ?? `codex-pro: the run ended as ${outcome.stopReason}`,
      outcome.threadId,
      outcome.images ?? [],
      outcome,
    )
  }
  return {
    text,
    threadId: outcome.threadId,
    images: outcome.images ?? [],
    usage: outcome.usage,
    rateLimits: outcome.rateLimits,
    ...(outcome.configuration === undefined ? {} : { configuration: outcome.configuration }),
    cleanup: outcome.cleanup,
    ...(outcome.structured === undefined ? {} : { structured: outcome.structured }),
  }
}

/**
 * One-shot Codex child lifecycle over the real app-server.
 *
 * Ported from `@deepseek-ai/dsh-subagent-codex`'s run module. The harness's
 * subprocess seam is replaced with `node:child_process` plus an explicit
 * termination ladder, and the result is settled here rather than through the
 * harness's `settleRunResult`, so this package stays dependency-free.
 *
 * The app-server is started from the configured executable on `PATH` rather than
 * from `@openai/codex`'s manifest, which removes a resolution dependency the
 * official adapter carries.
 *
 * @module dsh-subagent-codex-pro/run
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { LineTransport, type JsonRpcMessage } from './jsonrpc.ts'
import { CodexAppServerWire, DEFAULT_ORIGINATOR, type CodexPermissionMode, type CodexStopReason } from './wire.ts'
import type { CodexImage, CodexThreadMode } from './wire.ts'

/** Default grace between termination tiers. */
const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** The task text blocks a run accepts. */
export type PromptBlocks = readonly { readonly type: string; readonly text?: string }[]

/** Everything one run needs that does not change between attempts. */
export interface CodexRunSpec {
  /** The delegating session's working directory. */
  readonly cwd: string
  /** The Codex executable. */
  readonly command: string
  /** Unattended permission policy. */
  readonly permissionMode: CodexPermissionMode
  /** Model for `thread/start`, when the caller chose one. */
  readonly model?: string | undefined
  /** Default thinking level for `thread/start`, when the caller chose one. */
  readonly reasoningEffort?: string | undefined
  /** Per-turn thinking level for `turn/start`, when the caller chose one. */
  readonly effort?: string | undefined
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
}

/** The published run. */
export interface StartedCodexRun {
  /** A durable id for the harness's catalog. */
  readonly id: string
  /** Never rejects: a failure arrives as `stopReason: 'error'` plus a diagnostic. */
  readonly result: Promise<CodexRunOutcome>
  /** Ask the child to stop; local settlement stays authoritative. */
  requestCancel(): void
  /** Release the process range. Idempotent, and awaited by the caller. */
  teardown(): Promise<void>
}

/** A spawned process plus the lifecycle operations the run needs. */
interface ManagedChild {
  readonly proc: ChildProcessWithoutNullStreams
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  terminate(): void
  waitForExit(timeoutMs?: number): Promise<void>
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

/** A run failure, kept for its structured facts. */
export class CodexRunFailure extends Error {
  readonly facts: FailureFacts

  constructor(facts: FailureFacts, cause?: unknown) {
    super(`codex-pro: product subagent failure (${describeFacts(facts)})`, cause === undefined ? undefined : { cause })
    this.facts = facts
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

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 *
 * @param prompt - the delegation's content blocks.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: PromptBlocks): string[] {
  if (prompt.length === 0) throw new Error('codex-pro: the one-shot task must contain only text blocks')
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('codex-pro: the one-shot task must contain only text blocks')
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
 * @param spec - the executable, working directory, and environment.
 * @returns the managed child.
 */
function spawnAppServer(spec: CodexRunSpec, graceMs: number): ManagedChild {
  const proc = spawn(spec.command, ['app-server', '--stdio'], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
  })
  done.catch(() => {})
  let killed = false
  return {
    proc,
    done,
    terminate: () => {
      if (killed) return
      killed = true
      // Tier one: a signal the child can act on. Tier two is unconditional.
      try { proc.kill('SIGTERM') } catch { /* already gone */ }
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already gone */ }
      }, graceMs)
      timer.unref?.()
      void done.finally(() => { clearTimeout(timer) })
    },
    waitForExit: (timeoutMs) => {
      const exited = done.then(() => undefined, () => undefined)
      if (timeoutMs === undefined) return exited
      return Promise.race([
        exited,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs)
          timer.unref?.()
        }),
      ])
    },
  }
}

/** Build the argv, for diagnostics and tests. */
export function codexAppServerArgv(command: string): string[] {
  return [command, 'app-server', '--stdio']
}

/**
 * Start the app-server child and publish its one-shot run.
 *
 * Resolves only after initialization and ephemeral thread creation, so a failure
 * before that point rejects with no run published.
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
  if (signal.aborted) throw new Error('codex-pro: request was aborted before app-server startup')
  const graceMs = spec.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  let child: ManagedChild
  try {
    child = spawnAppServer(spec, graceMs)
  } catch (error: unknown) {
    throw new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, thrown(error))
  }

  const transport = new LineTransport(child.proc.stdin, child.proc.stdout)
  const wire = new CodexAppServerWire(
    child.proc.stdout,
    child.proc.stdin,
    transport,
    {
      permissionMode: spec.permissionMode,
      model: spec.model,
      reasoningEffort: spec.reasoningEffort,
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

  let processFailureFacts: FailureFacts | undefined
  const processFailure = child.done.then(
    () => {
      processFailureFacts = { stage: 'process', category: 'process' }
      throw new CodexRunFailure({ stage: 'process', category: 'process' })
    },
    (error: unknown) => {
      processFailureFacts = { stage: 'process', category: 'unknown' }
      throw new CodexRunFailure(processFailureFacts, thrown(error))
    },
  )
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  /** Set when the deadline fired, so the settlement can say why it ended. */
  let timedOut = false
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('codex-pro: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }

  const timeoutMs = spec.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const deadline = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true
        requestCancel()
      }, timeoutMs)
    : undefined
  // Never hold the process open for a deadline that only cancels work.
  deadline?.unref?.()

  const teardown = async (): Promise<void> => {
    if (deadline !== undefined) clearTimeout(deadline)
    wire.close()
    try { child.proc.stdin.end() } catch { /* already closed */ }
    child.terminate()
    await child.waitForExit(graceMs + 500)
    child.proc.stderr.off('data', forwardStderr)
  }
  let tornDown: Promise<void> | undefined
  const teardownOnce = (): Promise<void> => (tornDown ??= teardown())

  signal.addEventListener('abort', onAbort, { once: true })

  let startupStage = 'initialize'
  try {
    await Promise.race([wire.initialize(signal), processFailure])
    startupStage = spec.resumeThreadId === undefined ? 'thread-start' : 'thread-resume'
    await Promise.race([
      spec.resumeThreadId === undefined
        ? wire.startThread(spec.cwd, signal)
        : wire.resumeThread(spec.resumeThreadId, signal),
      processFailure,
    ])
    // A persistent thread is named so the Codex application's list says where it
    // came from; the id alone cannot, because the originator has to be the value
    // that client filters on.
    if (spec.threadMode === 'persistent' && spec.threadName !== undefined) {
      await wire.setThreadName(spec.threadName, signal)
    }
  } catch (error: unknown) {
    signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    const failure = new CodexRunFailure({ stage: startupStage, category: 'unknown' }, thrown(error))
    try {
      await teardownOnce()
    } catch (disposeError: unknown) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError([failure, cleanupFailure], `${failure.message}; ${cleanupFailure.message}`)
    }
    if (cancelledBeforeCleanup || signal.aborted) {
      throw new Error('codex-pro: request was aborted before run publication')
    }
    throw failure
  }

  const withProcessOutcome = (facts: FailureFacts | undefined): FailureFacts =>
    facts ?? processFailureFacts ?? { stage: 'turn', category: 'unknown' }

  /** Settle the run without ever rejecting: a failure becomes a stop reason. */
  const settle = async (): Promise<CodexRunOutcome> => {
    try {
      const terminal = await Promise.race([wire.runTurn(texts, runAbort.signal, spec.effort), processFailure])
      if (terminal.stopReason === 'completed') {
        return { output: terminal.output, stopReason: terminal.stopReason, threadId: wire.threadId, images: terminal.images }
      }
      await new Promise((resolve) => { setImmediate(resolve) })
      const facts = withProcessOutcome(wire.collectFailure())
      const failure = describeFacts(facts)
      const permission = wire.collectDiagnostic()
      return {
        output: terminal.output,
        stopReason: timedOut ? 'timeout' : terminal.stopReason,
        diagnostic: timedOut
          ? `${describeTimeout(timeoutMs)}${permission === undefined ? '' : `\n${permission}`}`
          : permission === undefined ? failure : `${failure}\n${permission}`,
        threadId: wire.threadId,
        images: terminal.images,
      }
    } catch (error: unknown) {
      await new Promise((resolve) => { setImmediate(resolve) })
      const facts = error instanceof CodexRunFailure ? error.facts : withProcessOutcome(wire.collectFailure())
      const failure = describeFacts(facts)
      const permission = wire.collectDiagnostic()
      return {
        output: [],
        stopReason: timedOut ? 'timeout' : runAbort.signal.aborted ? 'aborted' : 'error',
        diagnostic: timedOut
          ? `${describeTimeout(timeoutMs)}${permission === undefined ? '' : `\n${permission}`}`
          : permission === undefined ? failure : `${failure}\n${permission}`,
        threadId: wire.threadId,
        images: wire.images,
      }
    }
  }

  const result = settle()

  return {
    id: randomUUID(),
    result,
    requestCancel,
    teardown: teardownOnce,
  }
}

/** The message shapes the wire exchanges, re-exported for diagnostics. */
export type { JsonRpcMessage }

/**
 * Run one delegation to completion and return its final text.
 *
 * The whole protocol lifecycle — spawn, handshake, ephemeral thread, one turn,
 * teardown — behind a single call, for callers that want the answer rather than
 * a handle.
 *
 * @param options - the task, its working directory, and the two choices.
 * @returns the child's final message.
 * @throws when the run does not complete; the diagnostic is the message.
 */
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
 * Carries the thread it used: a persistent thread that failed is still a thread
 * the user may want to open or remove, and the message is the only thing most
 * callers look at.
 */
export class CodexDelegationFailure extends Error {
  /** The thread the failed run used, when the app-server had got that far. */
  readonly threadId: string | undefined
  /** Images the failed run produced before it failed. */
  readonly images: readonly CodexImage[]

  constructor(message: string, threadId: string | undefined, images: readonly CodexImage[] = []) {
    super(message)
    this.name = 'CodexDelegationFailure'
    this.threadId = threadId
    this.images = images
  }
}

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
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly signal: AbortSignal
  /** Called once the run is published, for diagnostics. */
  readonly onStart?: (id: string) => void
  /** Narrates notable child activity. */
  readonly onProgress?: ((text: string) => void) | undefined
}): Promise<{
  readonly text: string
  readonly threadId: string | undefined
  readonly images: readonly CodexImage[]
}> {
  const run = await startCodexRun(
    [{ type: 'text', text: options.prompt }],
    {
      cwd: options.cwd,
      command: options.command,
      permissionMode: options.permissionMode,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      // The same choice reaches both fields: the thread default and this turn.
      effort: options.reasoningEffort,

        threadMode: options.threadMode,
        resumeThreadId: options.threadId,
        originator: options.originator,
        runTimeoutMs: options.runTimeoutMs,
        threadName: options.threadName,      env: options.env,
      onProgress: options.onProgress,
    },
    options.signal,
  )
  options.onStart?.(run.id)
  try {
    const outcome = await run.result
    const text = outcome.output.map((block) => block.text).join('\n\n')
      if (outcome.stopReason === 'completed' && text !== '') {
        return { text, threadId: outcome.threadId, images: outcome.images ?? [] }
      }
    // A failure still reports its thread: a persistent thread that half-ran is
    // still one the user may want to open or clean up.
    throw new CodexDelegationFailure(
      outcome.diagnostic ?? `codex-pro: the run ended as ${outcome.stopReason}`,
      outcome.threadId,
      outcome.images ?? [],
    )
  } finally {
    await run.teardown()
  }
}

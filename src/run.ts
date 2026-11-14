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

import { nativeArguments, type NativeRequest, type NativeReceipt, type NativeEvent } from './native.ts'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { LineTransport, type JsonRpcMessage } from './jsonrpc.ts'
import { verifyStructuredOutput } from './structured.ts'
import {
  CodexAppServerWire,
  DEFAULT_ORIGINATOR,
  raceAbort,
  type AppliedConfiguration,
  type CodexPermissionMode,
  type CodexRateLimitsReport,
  type CodexResumeOverrides,
  type CodexStopReason,
  type TurnConfiguration,
} from './wire.ts'
import type { CodexImage, CodexThreadMode } from './wire.ts'
import type { CodexUsageReport } from './usage.ts'

/** Default grace between termination tiers. */
const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Hard upper bound on observing a process group disappear after SIGKILL. */
const GROUP_REAP_TIMEOUT_MS = 2_000
/** A dead leader cannot lend an infinite stdout lease to a descendant. */
const EXIT_DRAIN_TIMEOUT_MS = 1_000

/** Bound protocol and diagnostic output retained/forwarded by this adapter. */
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_TIMER_MS = 2_147_483_647

/** The task text blocks a run accepts. */
export type PromptBlocks = readonly { readonly type: string; readonly text?: string }[]

/** What happened to the process range at cleanup. */
export interface CleanupReport {
  /** Whether the whole owned process group is confirmed gone. */
  readonly confirmed: boolean
  /** Why confirmation was impossible, when it was. */
  readonly detail?: string
}

/** Physical facts about one attempt, separate from the model's terminal turn. */
export interface CodexRunExecution {
  readonly runId: string
  readonly dispatch: 'not-dispatched' | 'possible' | 'accepted'
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly threadId: string | null
  readonly turnId: string | null
  readonly pid: number | null
  readonly supervisorPid: number | null
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly supervisorExitCode: number | null
  readonly supervisorSignal: NodeJS.Signals | null
  readonly terminationRequested: boolean
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly truncated: boolean
  readonly spawnError: string | null
  readonly failure: FailureFacts | null
  readonly ownership: 'supervised-group' | 'owned-process'
}

/** Everything one run needs that does not change between attempts. */
export interface CodexRunSpec {
  /** Internal machine correlation selected before the supervised run starts. */
  readonly runId?: string
  readonly native?: NativeRequest
  readonly onNativeEvent?: ((event: NativeEvent) => void) | undefined
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
  /** Maximum stdout/stderr bytes before a non-successful, truncated result. */
  readonly maxOutputBytes?: number | undefined
  /** Narrates notable child activity, for a caller that reports progress. */
  readonly onProgress?: ((text: string) => void) | undefined
  /** Awaitable structured persistence barriers, independent from progress text. */
  readonly onLifecycle?: ((event: CodexRunLifecycle) => Promise<void> | void) | undefined
}

export interface CodexRunLifecycle {
  readonly event: 'thread-ready' | 'dispatch-intent' | 'dispatch-possible' | 'turn-accepted'
  readonly runId: string
  readonly threadId: string | null
  readonly turnId: string | null
  readonly configuration: AppliedConfiguration | null
}

/** What one finished run reports. */
export interface CodexRunOutcome {
  readonly native?: NativeReceipt
  readonly output: readonly { readonly type: 'text'; readonly text: string }[]
  readonly stopReason: CodexStopReason
  readonly diagnostic?: string
  /**
   * Bounded, package-generated approval/sandbox note, safe for Host diagnostics.
   * Raw server messages and task text are never copied here.
   */
  readonly approvalDiagnostic?: string
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
  readonly execution: CodexRunExecution
  /** A turn request is evidence of acceptance, not a server effort echo. */
  readonly turnConfiguration?: TurnConfiguration | undefined
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
  outputIncomplete(): boolean
  supervisorFailed(): boolean
  releaseUnconfirmed(): void
  facts(): {
    pid: number | null
    supervisorPid: number | null
    exitCode: number | null
    signal: NodeJS.Signals | null
    supervisorExitCode: number | null
    supervisorSignal: NodeJS.Signals | null
    terminationRequested: boolean
    spawnError: string | null
  }
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
export interface FailureFacts {
  readonly stage: string
  readonly category: string
  readonly httpStatus?: number
}

/** A run failure, kept for its structured facts and any cleanup it observed. */
export class CodexRunFailure extends Error {
  readonly facts: FailureFacts
  readonly native: NativeReceipt | undefined
  readonly cleanup: CleanupReport | undefined
  readonly execution: CodexRunExecution | undefined
  readonly configuration: AppliedConfiguration | undefined
  readonly usage: CodexUsageReport | undefined
  readonly rateLimits: CodexRateLimitsReport | undefined
  readonly turnConfiguration: TurnConfiguration | undefined

  constructor(facts: FailureFacts, cause?: unknown, cleanup?: CleanupReport, observations?: {
    native?: NativeReceipt | undefined
    execution?: CodexRunExecution
    configuration?: AppliedConfiguration | undefined
    usage?: CodexUsageReport
    rateLimits?: CodexRateLimitsReport
    turnConfiguration?: TurnConfiguration | undefined
  }) {
    const cleanupDetail = cleanup?.confirmed === false
      ? `; process cleanup unconfirmed${cleanup.detail === undefined ? '' : `: ${cleanup.detail}`}`
      : ''
    super(`codex-pro: product subagent failure (${describeFacts(facts)})${cleanupDetail}`,
      cause === undefined ? undefined : { cause })
    this.native = observations?.native
    this.facts = facts
    this.cleanup = cleanup
    this.execution = observations?.execution
    this.configuration = observations?.configuration
    this.usage = observations?.usage
    this.rateLimits = observations?.rateLimits
    this.turnConfiguration = observations?.turnConfiguration
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

/** Append a bounded reason to an optional diagnostic. */
function appendDiagnostic(diagnostic: string | undefined, detail: string): string {
  return diagnostic === undefined ? detail : `${diagnostic}; ${detail}`
}

/** A valid snapshot before interruption is a known lower bound, not a final bill. */
function partialUsage(usage: CodexUsageReport, reason: string): CodexUsageReport {
  if (usage.status !== 'complete') return usage
  return { ...usage, status: 'partial', reason: usage.reason === undefined ? reason : `${usage.reason}; ${reason}` }
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
  const graceMs = spec.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  // tsc rewrites import specifiers, not new URL strings. Native TS tests and
  // the built npm package must each start their matching guardian artifact.
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const guardian = fileURLToPath(new URL(`./process-guardian${extension}`, import.meta.url))
  const proc = spawn(posix ? process.execPath : spec.command,
    posix ? [guardian, spec.command, String(graceMs), JSON.stringify(nativeArguments(spec.native, { model: spec.model, effort: spec.effort ?? spec.reasoningEffort }))] : [...nativeArguments(spec.native, { model: spec.model, effort: spec.effort ?? spec.reasoningEffort }), 'app-server', '--stdio'], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: posix ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
    detached: posix,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams
  let actualPid: number | null = posix ? null : proc.pid ?? null
  let actualExit: { exitCode: number | null, signal: NodeJS.Signals | null } | undefined
  let stdoutEnded = false
  let drainTimer: NodeJS.Timeout | undefined
  let outputIncomplete = false
  let supervisorFailed = false
  let supervisorExit: { exitCode: number | null, signal: NodeJS.Signals | null } | undefined
  let spawnError: string | null = null
  let terminationRequested = false
  let completeActual!: (value: { exitCode: number | null, signal: NodeJS.Signals | null }) => void
  let failActual!: (error: Error) => void
  const done = new Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
    completeActual = resolve
    failActual = reject
  })
  done.catch(() => {})
  proc.stdout.once('end', () => {
    stdoutEnded = true
    if (drainTimer !== undefined) clearTimeout(drainTimer)
    drainTimer = undefined
    if (actualExit !== undefined) completeActual(actualExit)
    else if (supervisorFailed || supervisorExit !== undefined) {
      failActual(new CodexRunFailure({ stage: 'supervisor', category: 'process' }))
    }
  })
  proc.on('message', (message: unknown) => {
    if (message === null || typeof message !== 'object') return
    const value = message as Record<string, unknown>
    if (value.type === 'started' && Number.isSafeInteger(value.pid) && Number(value.pid) > 0) {
      actualPid = Number(value.pid)
    } else if (value.type === 'exit') {
      actualExit = {
        exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
        signal: typeof value.signal === 'string' ? value.signal as NodeJS.Signals : null,
      }
      if (stdoutEnded) completeActual(actualExit)
      else if (drainTimer === undefined) {
        // IPC and stdout use different pipes. Drain already-written final
        // frames before declaring an early exit, but never wait indefinitely
        // for a descendant that inherited stdout (even with runTimeoutMs=0).
        drainTimer = setTimeout(() => {
          outputIncomplete = true
          failActual(new Error('app-server exited but its output did not drain within 1000 ms'))
        }, EXIT_DRAIN_TIMEOUT_MS)
        drainTimer.unref?.()
      }
    } else if (value.type === 'spawn-error') {
      spawnError = typeof value.message === 'string' ? value.message : 'app-server spawn failed'
      failActual(new Error(spawnError))
    }
  })
  const supervisorDone = new Promise<void>((resolve) => {
    proc.once('error', (error) => {
      spawnError = error.message
      failActual(error)
      resolve()
    })
    proc.once('exit', (exitCode, signal) => {
      if (posix) {
        supervisorExit = { exitCode, signal }
        supervisorFailed ||= !terminationRequested
        // Guardian liveness cannot depend on stdio close: its Codex child may
        // still hold the inherited pipe. Allow queued final IPC/stdout frames
        // a bounded drain, then fail and let the caller terminate the group.
        if (actualExit === undefined && drainTimer === undefined) {
          drainTimer = setTimeout(() => {
            outputIncomplete = !stdoutEnded
            failActual(new CodexRunFailure({ stage: 'supervisor', category: 'process' }))
          }, EXIT_DRAIN_TIMEOUT_MS)
          drainTimer.unref?.()
        }
      } else {
        actualExit = { exitCode, signal }
        if (stdoutEnded) completeActual(actualExit)
        else if (drainTimer === undefined) {
          drainTimer = setTimeout(() => {
            outputIncomplete = true
            failActual(new CodexRunFailure({ stage: 'process', category: 'output-incomplete' }))
          }, EXIT_DRAIN_TIMEOUT_MS)
          drainTimer.unref?.()
        }
      }
      resolve()
    })
    proc.once('disconnect', () => {
      if (!posix || terminationRequested) return
      supervisorFailed = true
      if (actualExit !== undefined && stdoutEnded) completeActual(actualExit)
      else if (stdoutEnded) failActual(new CodexRunFailure({ stage: 'supervisor', category: 'process' }))
      else if (drainTimer === undefined) {
        drainTimer = setTimeout(() => {
          outputIncomplete = !stdoutEnded
          failActual(new CodexRunFailure({ stage: 'supervisor', category: 'process' }))
        }, EXIT_DRAIN_TIMEOUT_MS)
        drainTimer.unref?.()
      }
    })
    proc.once('close', (exitCode, signal) => {
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      if (posix) supervisorExit = { exitCode, signal }
      else {
        actualExit = { exitCode, signal }
        completeActual(actualExit)
      }
      // A guardian exit is not an app-server exit. In particular, a group KILL
      // can prevent the guardian from sending the actual child's final facts.
      if (actualExit === undefined) failActual(new Error('Codex guardian exited before an app-server exit receipt'))
      resolve()
    })
  })
  const groupPid = posix ? proc.pid : undefined
  let termination: Promise<CleanupReport> | undefined
  const signalErrors: string[] = []

  const groupState = (): { alive: boolean | undefined, detail?: string } => {
    if (groupPid !== undefined) {
      try {
        process.kill(-groupPid, 0)
        return { alive: true }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { alive: false }
        return { alive: undefined, detail: `cannot inspect the owned process group: ${thrown(error).message}` }
      }
    }
    return { alive: proc.exitCode === null && proc.signalCode === null }
  }

  const sendSignal = (signal: NodeJS.Signals): void => {
    terminationRequested = true
    try {
      if (groupPid !== undefined) process.kill(-groupPid, signal)
      else proc.kill(signal)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        signalErrors.push(`${signal}: ${thrown(error).message}`)
      }
    }
  }

  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
    supervisorDone.then(() => { clearTimeout(timer); resolve(true) })
  })

  const terminate = (grace: number): Promise<CleanupReport> => {
    if (termination !== undefined) return termination
    termination = (async (): Promise<CleanupReport> => {
      if (proc.pid === undefined) return { confirmed: true }
      sendSignal('SIGTERM')
      await waitForExit(grace)
      // A caller-requested guardian exit can happen before a descendant that
      // inherited stdout has let the stream drain. Give the existing drain
      // timer its bounded window before killing the group, so a held pipe is
      // still reported as output-incomplete instead of being silently closed.
      if (actualExit !== undefined && !stdoutEnded && !outputIncomplete) {
        await delay(EXIT_DRAIN_TIMEOUT_MS)
      }
      if (groupState().alive !== false) {
        sendSignal('SIGKILL')
        await waitForExit(Math.min(Math.max(grace, 250), GROUP_REAP_TIMEOUT_MS))
      }
      const until = performance.now() + GROUP_REAP_TIMEOUT_MS
      let state = groupState()
      while (state.alive !== false && performance.now() < until) {
        await delay(25)
        state = groupState()
      }
      // A signal can race the guardian's own group KILL. In particular, Darwin
      // can return EPERM while a group contains only exiting/zombie members.
      // That error is not proof of disappearance, but a later independent
      // ESRCH is. Do not let a historical signal error override that proof.
      if (state.alive === false) return { confirmed: true }
      return {
        confirmed: false,
        detail: [...signalErrors, state.detail ?? 'the owned process group was still alive after SIGKILL'].join('; '),
      }
    })()
    return termination
  }

  return {
    proc, done, terminate, waitForExit,
    outputIncomplete: () => outputIncomplete,
    supervisorFailed: () => supervisorFailed,
    releaseUnconfirmed: () => {
      // A failed signal must not keep the caller alive forever through its
      // own pipe/IPC references. Closing the lease lets the guardian make an
      // independent cleanup attempt. This is not confirmation: the already
      // failed receipt stays failed even if that later attempt succeeds.
      try { if (proc.connected) proc.disconnect() } catch { /* lease already closed */ }
      for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
        try { stream.destroy() } catch { /* already closed */ }
      }
      proc.unref()
    },
    facts: () => ({
      pid: actualPid,
      supervisorPid: posix ? proc.pid ?? null : null,
      exitCode: actualExit?.exitCode ?? null,
      signal: actualExit?.signal ?? null,
      supervisorExitCode: supervisorExit?.exitCode ?? null,
      supervisorSignal: supervisorExit?.signal ?? null,
      terminationRequested,
      spawnError,
    }),
  }
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
  const id = spec.runId ?? randomUUID()
  const startedAt = Date.now()
  const startedMonotonic = performance.now()
  let timedOut = false
  let callerAborted = false
  let truncated = false
  let initialSpawnError: string | null = null
  let observedChild: ManagedChild | undefined
  let observedWire: CodexAppServerWire | undefined
  const execution = (failure: FailureFacts | null): CodexRunExecution => ({
    runId: id,
    dispatch: observedWire?.dispatch ?? 'not-dispatched',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, performance.now() - startedMonotonic),
    threadId: observedWire?.threadId ?? null,
    turnId: observedWire?.turnId ?? null,
    ...(observedChild?.facts() ?? {
      pid: null, supervisorPid: null, exitCode: null, signal: null,
      supervisorExitCode: null, supervisorSignal: null,
      terminationRequested: false, spawnError: initialSpawnError,
    }),
    timedOut, cancelled: callerAborted || signal.aborted,
    truncated: truncated || observedChild?.outputIncomplete() === true, failure,
    ownership: process.platform === 'win32' ? 'owned-process' : 'supervised-group',
  })
  const graceMs = spec.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  const requestedTimeout = spec.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  let texts: string[]
  try {
    texts = textTask(prompt)
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30_000) {
      throw new Error('disposeGraceMs must be an integer between 0 and 30000')
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new Error('maxOutputBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 0 || requestedTimeout > MAX_TIMER_MS) {
      throw new Error('runTimeoutMs must be an integer between 0 and 2147483647')
    }
    if (spec.deadlineAt !== undefined && (!Number.isSafeInteger(spec.deadlineAt) || spec.deadlineAt <= 0
      || spec.deadlineAt - startedAt > MAX_TIMER_MS)) {
      throw new Error('deadlineAt must be a positive safe timestamp within the supported timer range')
    }
  } catch (error: unknown) {
    const facts = { stage: 'request', category: 'invalid-request' }
    throw new CodexRunFailure(facts, error, { confirmed: true }, { execution: execution(facts) })
  }
  if (signal.aborted) {
    callerAborted = true
    const facts = { stage: 'initialize', category: 'aborted' }
    throw new CodexRunFailure(facts, undefined, { confirmed: true }, { execution: execution(facts) })
  }
  const deadlineAt = spec.deadlineAt
    ?? (requestedTimeout > 0 ? startedAt + requestedTimeout : undefined)
  const timeoutDescriptionMs = deadlineAt === undefined ? requestedTimeout : Math.max(1, deadlineAt - startedAt)

  let child: ManagedChild
  try {
    child = spawnAppServer(spec)
    observedChild = child
  } catch (error: unknown) {
    initialSpawnError = thrown(error).message
    const facts = { stage: 'initialize', category: 'process' }
    throw new CodexRunFailure(facts, error, { confirmed: true }, { execution: execution(facts) })
  }

  const runAbort = new AbortController()
  let outputBytes = 0
  const limitOutput = (chunk: Buffer | string): void => {
    outputBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (outputBytes <= maxOutputBytes || truncated) return
    truncated = true
    runAbort.abort(new Error(`codex-pro: output exceeded ${String(maxOutputBytes)} bytes`))
    child.proc.stdout.destroy()
    child.proc.stderr.destroy()
  }
  child.proc.stdout.on('data', limitOutput)
  child.proc.stderr.on('data', limitOutput)
  const transport = new LineTransport(child.proc.stdin, child.proc.stdout)
  const wire = new CodexAppServerWire(
    child.proc.stdout,
    child.proc.stdin,
    transport,
    {
      permissionMode: spec.permissionMode,
      native: spec.native, onNativeEvent: spec.onNativeEvent, nativeCwd: spec.cwd, nativeReviewEffort: spec.effort ?? spec.reasoningEffort,
      model: spec.model,
      threadMode: spec.threadMode,
      originator: spec.originator ?? DEFAULT_ORIGINATOR,
    },
  )
  observedWire = wire
  if (spec.onProgress !== undefined) wire.setProgressReporter(spec.onProgress)
  const forwardStderr = (chunk: Buffer | string): void => {
    if (truncated) return
    try {
      process.stderr.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    } catch {
      // Diagnostics must never take the run down.
    }
  }
  child.proc.stderr.on('data', forwardStderr)

  let timer: NodeJS.Timeout | undefined
  const abortRun = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('codex-pro: run cancelled locally'))
    wire.interrupt()
  }
  const requestCancel = (): void => {
    callerAborted = true
    abortRun()
  }
  const onCallerAbort = (): void => {
    requestCancel()
  }
  if (deadlineAt !== undefined) {
    timer = setTimeout(() => {
      timedOut = true
      abortRun()
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
    wire.close()
    try { child.proc.stdin.end() } catch { /* already closed */ }
    const cleanup = await child.terminate(graceMs)
    if (!cleanup.confirmed) child.releaseUnconfirmed()
    signal.removeEventListener('abort', onCallerAbort)
    child.proc.stderr.off('data', forwardStderr)
    child.proc.stdout.off('data', limitOutput)
    child.proc.stderr.off('data', limitOutput)
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
      processFailureFacts = error instanceof CodexRunFailure ? error.facts : { stage: 'process', category: 'process' }
      throw new CodexRunFailure(processFailureFacts, error)
    },
  )
  processFailure.catch(() => {})

  const lifecycle = spec.onLifecycle === undefined ? undefined : async (event: CodexRunLifecycle['event']): Promise<void> => {
    await raceAbort(Promise.race([Promise.resolve().then(() => spec.onLifecycle!({ event, runId: id,
      threadId: wire.threadId ?? null, turnId: wire.turnId ?? null, configuration: wire.configuration ?? null })),
    processFailure]), runAbort.signal)
  }

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
    if (lifecycle !== undefined) await lifecycle('thread-ready')
  } catch (error: unknown) {
    const failureStage = processFailureFacts === undefined ? startupStage : 'process'
    const cleanup = await teardownOnce()
    const failure = startupFailure(
      failureStage,
      error,
      { timedOut, callerAborted },
      cleanup,
    )
    const facts = truncated ? { stage: startupStage, category: 'output-limit' }
      : child.outputIncomplete() ? { stage: startupStage, category: 'output-incomplete' }
        : failure.facts
    throw new CodexRunFailure(facts, error, cleanup, {
      ...(wire.nativeReport(cleanup.confirmed) === undefined ? {} : { native: wire.nativeReport(cleanup.confirmed) }),
      execution: execution(facts), configuration: wire.configuration,
      usage: partialUsage(wire.usageReport, 'startup ended without a completed turn'), rateLimits: wire.rateLimitsReport,
      turnConfiguration: wire.turnConfiguration,
    })
  }

  const finish = async (
    turn: { readonly output: readonly { readonly type: 'text', readonly text: string }[],
      readonly stopReason: CodexStopReason, readonly images: readonly CodexImage[] } | undefined,
    error: unknown,
  ): Promise<CodexRunOutcome> => {
    let failure: FailureFacts | null = error instanceof CodexRunFailure
      ? error.facts
      : error === undefined ? null : { stage: 'turn', category: 'protocol' }
    const cleanup = await teardownOnce()
    callerAborted ||= signal.aborted
    const effectiveTruncated = truncated || child.outputIncomplete()
    const usage = turn === undefined || timedOut || callerAborted || effectiveTruncated || !cleanup.confirmed
      ? partialUsage(wire.usageReport, 'run ended without a reliable terminal usage boundary')
      : wire.usageReport
    const rateLimits = wire.rateLimitsReport
    const configuration = wire.configuration
    const observedImages = turn?.images ?? wire.images
    let output = turn?.output ?? wire.partialOutput
    let stopReason: CodexStopReason = effectiveTruncated ? 'error'
      : timedOut ? 'timeout'
        : callerAborted ? 'aborted'
          : turn?.stopReason ?? 'error'
    const approvalDiagnostic = wire.collectDiagnostic()
    let diagnostic = approvalDiagnostic
    let structured: unknown
    let schemaError: string | undefined

    const processFacts = child.facts()
    if (child.supervisorFailed()) {
      if (stopReason === 'completed') stopReason = 'error'
      failure = { stage: 'supervisor', category: 'process' }
      diagnostic = appendDiagnostic(diagnostic, 'Codex guardian exited before cleanup was requested')
    }
    if ((processFacts.exitCode !== null && processFacts.exitCode !== 0)
      || (processFacts.signal !== null && !['SIGTERM', 'SIGKILL'].includes(processFacts.signal))) {
      if (stopReason === 'completed') stopReason = 'error'
      failure = { stage: 'process', category: 'process' }
      diagnostic = appendDiagnostic(diagnostic,
        `app-server exited unexpectedly (code=${String(processFacts.exitCode)}, signal=${String(processFacts.signal)})`)
    }

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
        failure = { stage: 'output', category: 'schema' }
        diagnostic = diagnostic === undefined ? schemaError : `${diagnostic}; ${schemaError}`
      }
    }

    if (!cleanup.confirmed) {
      if (stopReason === 'completed') stopReason = 'error'
      failure ??= { stage: 'cleanup', category: 'cleanup' }
      const cleanupDetail = `process cleanup could not be confirmed${cleanup.detail === undefined ? '' : `: ${cleanup.detail}`}`
      diagnostic = diagnostic === undefined ? cleanupDetail : `${diagnostic}; ${cleanupDetail}`
    }
    const native = wire.nativeReport(cleanup.confirmed)
    if (native !== undefined && (!native.effective.matched || !native.completion.confirmed || !native.cleanup.confirmed)) {
      if (stopReason === 'completed') stopReason = 'error'
      failure ??= { stage: 'native', category: !native.effective.matched ? 'configuration' : 'completion' }
      diagnostic = appendDiagnostic(diagnostic, !native.effective.matched
        ? 'native configuration was not confirmed'
        : 'native child completion or cleanup could not be confirmed')
    }
    if (effectiveTruncated) {
      if (truncated) failure = { stage: 'output', category: 'output-limit' }
      else failure ??= { stage: 'output', category: 'output-incomplete' }
      const detail = truncated
        ? `codex-pro: output exceeded ${String(maxOutputBytes)} bytes and was truncated`
        : 'codex-pro: app-server output could not be completely drained'
      diagnostic = diagnostic === undefined ? detail : `${diagnostic}; ${detail}`
    } else if (timedOut) {
      failure = { stage: 'turn', category: 'timeout' }
      const timeoutDetail = describeTimeout(timeoutDescriptionMs)
      diagnostic = diagnostic === undefined ? timeoutDetail : `${diagnostic}; ${timeoutDetail}`
    } else if (callerAborted) {
      failure = { stage: 'turn', category: 'aborted' }
      const abortDetail = 'codex-pro: the delegation was cancelled by its caller'
      diagnostic = diagnostic === undefined ? abortDetail : `${diagnostic}; ${abortDetail}`
    } else if (error !== undefined && diagnostic === undefined) {
      diagnostic = error instanceof Error ? error.message : String(error)
    } else if (error !== undefined && !(error instanceof CodexRunFailure)) {
      diagnostic = `${diagnostic}; ${error instanceof Error ? error.message : String(error)}`
    }
    if (stopReason !== 'completed' && failure === null) {
      failure = { stage: 'turn', category: stopReason }
    }

    return {
      ...(native === undefined ? {} : { native }),
      output,
      stopReason,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(approvalDiagnostic === undefined ? {} : { approvalDiagnostic }),
      threadId: wire.threadId,
      images: observedImages,
      usage,
      rateLimits,
      ...(configuration === undefined ? {} : { configuration }),
      cleanup,
      execution: execution(failure),
      ...(wire.turnConfiguration === undefined ? {} : { turnConfiguration: wire.turnConfiguration }),
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
          lifecycle,
        ),
        processFailure,
      ])
      return await finish(turn, undefined)
    } catch (error: unknown) {
      return await finish(undefined, error)
    }
  })()

  return {
    id,
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
  readonly native?: NativeReceipt
  readonly text: string
  readonly threadId: string | undefined
  readonly images: readonly CodexImage[]
  readonly usage: CodexUsageReport
  readonly rateLimits: CodexRateLimitsReport
  readonly configuration?: AppliedConfiguration
  readonly cleanup: CleanupReport
  readonly execution: CodexRunExecution
  readonly turnConfiguration?: TurnConfiguration
  readonly structured?: unknown
}

/** Run one delegation and return its settled outcome. */
export async function runCodexOnce(
  options: {
    readonly prompt: string
    readonly native?: NativeRequest | undefined
    readonly onNativeEvent?: ((event: NativeEvent) => void) | undefined
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
    readonly disposeGraceMs?: number | undefined
    readonly maxOutputBytes?: number | undefined
    readonly signal: AbortSignal
    readonly onStart?: ((id: string) => void) | undefined
    readonly onProgress?: ((text: string) => void) | undefined
  },
): Promise<CodexRunOutcome> {
  const run = await startCodexRun(
    [{ type: 'text', text: options.prompt }],
    {
      ...(options.native === undefined ? {} : { native: options.native }),
      ...(options.onNativeEvent === undefined ? {} : { onNativeEvent: options.onNativeEvent }),
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
      disposeGraceMs: options.disposeGraceMs,
      maxOutputBytes: options.maxOutputBytes,
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
  readonly native?: NativeRequest | undefined
  readonly onNativeEvent?: ((event: NativeEvent) => void) | undefined
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
  readonly disposeGraceMs?: number | undefined
  readonly maxOutputBytes?: number | undefined
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
    ...(outcome.native === undefined ? {} : { native: outcome.native }),
    text,
    threadId: outcome.threadId,
    images: outcome.images ?? [],
    usage: outcome.usage,
    rateLimits: outcome.rateLimits,
    ...(outcome.configuration === undefined ? {} : { configuration: outcome.configuration }),
    cleanup: outcome.cleanup,
    execution: outcome.execution,
    ...(outcome.turnConfiguration === undefined ? {} : { turnConfiguration: outcome.turnConfiguration }),
    ...(outcome.structured === undefined ? {} : { structured: outcome.structured }),
  }
}

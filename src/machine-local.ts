/** Private one-run implementation, supervised by the public machine API. */
import { randomUUID } from 'node:crypto'
import { CodexRunFailure, DEFAULT_RUN_TIMEOUT_MS, startCodexRun, type CodexRunSpec } from './run.ts'
import type { CodexPermissionMode } from './wire.ts'
import { parseMachineRequest, type MachineRequest, type MachineOptions, type MachineReceipt } from './machine.ts'
import type { MachineLifecycleEvent } from './machine-recovery.ts'

/** Bound a diagnostic without retaining arbitrary server output. */
function boundedDiagnostic(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?').slice(0, 4096)
}

/** Include the cause of a startup failure, which carries the actionable reason. */
function failureDiagnostic(error: CodexRunFailure | undefined): string {
  if (error === undefined) return 'codex-pro: run could not be initialized'
  const cause = (error as Error & { cause?: unknown }).cause
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined
  const base = error.message
  const detail = causeMessage === undefined || base.includes(causeMessage)
    ? base
    : base + ': ' + causeMessage
  return boundedDiagnostic(detail)
}

/** Private supervisor entry; callers use runMachine so caller death cannot lose cleanup persistence. */
export async function runMachineLocal(value: MachineRequest, options: MachineOptions = {}, id: string = randomUUID(),
  persistReceipt?: (receipt: MachineReceipt) => void): Promise<MachineReceipt> {
  const request = parseMachineRequest(value)
  let sequence = 0
  let dispatch: MachineLifecycleEvent['dispatch'] = 'not-dispatched'
  let last: MachineLifecycleEvent | undefined
  const emit = async (event: MachineLifecycleEvent['event'], patch: Partial<MachineLifecycleEvent> = {}): Promise<void> => {
    if (options.onLifecycle === undefined) return
    sequence += 1
    const lifecycle: MachineLifecycleEvent = { threadId: null, turnId: null,
      persistent: request.threadMode === 'persistent' || request.threadId !== undefined,
      configuration: null, dispatch, outcome: 'unknown', cleanupConfirmed: false, ...last, ...patch,
      // Identity/order never come from an inherited or caller-provided snapshot.
      lifecycleVersion: 1, type: 'lifecycle', requestId: request.requestId, runId: id, sequence, event }
    last = lifecycle
    await options.onLifecycle(lifecycle)
  }
  const finish = async (receipt: MachineReceipt): Promise<MachineReceipt> => {
    // Native facts are final here. Persist them BEFORE a terminal notification
    // can be lost; delivery failure must not turn a known outcome into cancellation.
    persistReceipt?.(receipt)
    const run = receipt.outcome ?? receipt.failure
    const execution = run?.execution
    const terminal = receipt.ok ? 'completed' : execution?.cancelled === true ? 'cancelled'
      : dispatch === 'not-dispatched' ? 'failed' : 'unknown'
    const facts: Partial<MachineLifecycleEvent> = {
      threadId: execution?.threadId ?? last?.threadId ?? null, turnId: execution?.turnId ?? last?.turnId ?? null,
      configuration: (run?.configuration ?? last?.configuration ?? null) as MachineLifecycleEvent['configuration'],
      dispatch, outcome: terminal, cleanupConfirmed: run?.cleanup?.confirmed === true,
    }
    try { await emit('terminal', facts) } catch { /* The original receipt was already made durable. */ }
    if (facts.cleanupConfirmed === true) {
      try { await emit('cleanup-confirmed', facts) } catch { /* A failed final ACK is not new model execution. */ }
    }
    return receipt
  }
  const requested = {
    cwd: request.cwd, model: request.model, effort: request.effort,
    permissionMode: request.permissionMode, threadId: request.threadId ?? null,
  }
  const spec: CodexRunSpec = {
    runId: id,
    cwd: request.cwd,
    command: request.command ?? 'codex',
    model: request.model,
    effort: request.effort,
    permissionMode: request.permissionMode as CodexPermissionMode,
    runTimeoutMs: request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    threadMode: request.threadMode ?? (request.threadId === undefined ? 'ephemeral' : 'persistent'),
    ...(request.threadId === undefined ? {} : { resumeThreadId: request.threadId }),
    ...(request.maxOutputBytes === undefined ? {} : { maxOutputBytes: request.maxOutputBytes }),
    ...(request.images === undefined ? {} : { images: request.images }),
    ...(request.native === undefined ? {} : { native: request.native }),
    ...(options.onNativeEvent === undefined ? {} : { onNativeEvent: options.onNativeEvent }),
    ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.onLifecycle === undefined ? {} : { onLifecycle: async (event) => {
      if (event.event === 'dispatch-possible') dispatch = 'possible'
      if (event.event === 'turn-accepted') dispatch = 'accepted'
      await emit(event.event, { threadId: event.threadId, turnId: event.turnId,
        configuration: event.configuration as unknown as MachineLifecycleEvent['configuration'], dispatch })
    } }),
  }
  let receipt: MachineReceipt
  try {
    const run = await startCodexRun([{ type: 'text', text: request.prompt }], spec, options.signal ?? new AbortController().signal)
    const outcome = await run.result
    receipt = {
      protocol: 1, type: 'result', requestId: request.requestId, runId: run.id,
      ok: outcome.stopReason === 'completed' && outcome.cleanup.confirmed && outcome.native?.completion.confirmed !== false,
      requested, outcome, failure: null, ...(outcome.native === undefined ? {} : { native: outcome.native }), costUSD: null, costStatus: 'unknown',
    }
  } catch (error: unknown) {
    const failure = error instanceof CodexRunFailure ? error : undefined
    receipt = {
      protocol: 1, type: 'result', requestId: request.requestId,
      runId: failure?.execution?.runId ?? id, ok: false, requested, outcome: null,
      failure: {
        stage: failure?.facts.stage ?? 'initialize', category: failure?.facts.category ?? 'runtime',
        diagnostic: failureDiagnostic(failure),
        execution: failure?.execution ?? null,
        configuration: failure?.configuration ?? null,
        usage: failure?.usage ?? null,
        rateLimits: failure?.rateLimits ?? null,
        turnConfiguration: failure?.turnConfiguration ?? null,
        cleanup: failure?.cleanup ?? null,
      },
      ...(failure?.native === undefined ? {} : { native: failure.native }),
      costUSD: null, costStatus: 'unknown',
    }
  }
  return finish(receipt)
}


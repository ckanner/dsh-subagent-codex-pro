/** Versioned, host-independent entry point for deterministic orchestrators. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  CodexRunFailure, DEFAULT_RUN_TIMEOUT_MS, startCodexRun,
  type CodexRunOutcome, type CodexRunSpec,
} from './run.ts'
import type { CodexPermissionMode } from './wire.ts'

export const MACHINE_PROTOCOL_VERSION = 1 as const

/** Caller input contains no credentials. Child authentication stays in its environment. */
export interface MachineRequest {
  readonly protocol: 1
  readonly requestId: string
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  readonly effort: string
  readonly permissionMode: 'read-only' | 'workspace-write' | 'dangerously-bypass-approvals-and-sandbox'
  readonly command?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly threadMode?: 'ephemeral' | 'persistent'
  readonly threadId?: string
  readonly images?: readonly string[]
  readonly outputSchema?: Record<string, unknown>
}

export interface MachineOptions {
  readonly signal?: AbortSignal
  readonly env?: Readonly<Record<string, string>>
  readonly onProgress?: (text: string) => void
}

/** The result is not mixed into the model's structured answer or human thread marker. */
export interface MachineReceipt {
  readonly protocol: 1
  readonly type: 'result'
  readonly requestId: string
  readonly runId: string
  readonly ok: boolean
  readonly requested: {
    readonly cwd: string
    readonly model: string
    readonly effort: string
    readonly permissionMode: MachineRequest['permissionMode']
    readonly threadId: string | null
  }
  readonly outcome: CodexRunOutcome | null
  readonly failure: {
    readonly stage: string
    readonly category: string
    readonly diagnostic: string
    readonly execution: CodexRunFailure['execution'] | null
    readonly configuration: CodexRunFailure['configuration'] | null
    readonly usage: CodexRunFailure['usage'] | null
    readonly rateLimits: CodexRunFailure['rateLimits'] | null
    readonly turnConfiguration: CodexRunFailure['turnConfiguration'] | null
    readonly cleanup: CodexRunFailure['cleanup'] | null
  } | null
  readonly costUSD: null
  readonly costStatus: 'unknown'
}

export class MachineInputError extends Error {
  readonly code = 'INVALID_REQUEST'
  constructor(message: string) { super(message); this.name = 'MachineInputError' }
}

const INPUT_KEYS = new Set([
  'protocol', 'requestId', 'prompt', 'cwd', 'model', 'effort', 'permissionMode',
  'command', 'timeoutMs', 'maxOutputBytes', 'threadMode', 'threadId', 'images', 'outputSchema',
])

function textField(input: Record<string, unknown>, key: string, optional = false): void {
  const value = input[key]
  if (optional && value === undefined) return
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new MachineInputError(key + ' must be a nonempty string without NUL')
  }
}

/** Validate before starting any process; unknown options never silently disappear. */
export function parseMachineRequest(value: unknown): MachineRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MachineInputError('request must be a JSON object')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) throw new MachineInputError('request contains an unsupported field')
  if (input.protocol !== MACHINE_PROTOCOL_VERSION) throw new MachineInputError('unsupported machine protocol version')
  for (const key of ['requestId', 'prompt', 'cwd', 'model', 'effort']) textField(input, key)
  for (const key of ['command', 'threadId']) textField(input, key, true)
  if (!isAbsolute(input.cwd as string)) throw new MachineInputError('cwd must be absolute')
  if (typeof input.permissionMode !== 'string'
    || !['read-only', 'workspace-write', 'dangerously-bypass-approvals-and-sandbox'].includes(input.permissionMode)) {
    throw new MachineInputError('permissionMode must explicitly select a supported sandbox')
  }
  for (const key of ['timeoutMs', 'maxOutputBytes']) {
    const number = input[key]
    if (number !== undefined && (!Number.isSafeInteger(number) || (number as number) < (key === 'timeoutMs' ? 0 : 1)
      || (key === 'timeoutMs' && (number as number) > 2_147_483_647))) {
      throw new MachineInputError(key + ' must be a safe integer in its allowed range')
    }
  }
  if (input.threadMode !== undefined && (typeof input.threadMode !== 'string'
    || !['ephemeral', 'persistent'].includes(input.threadMode))) {
    throw new MachineInputError('unsupported threadMode')
  }
  if (input.threadId !== undefined && input.threadMode === 'ephemeral') {
    throw new MachineInputError('resuming a thread requires persistent mode')
  }
  if (input.images !== undefined && (!Array.isArray(input.images)
    || input.images.some((path: unknown) => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')))) {
    throw new MachineInputError('images must contain absolute paths')
  }
  if (input.outputSchema !== undefined) {
    const schema = input.outputSchema
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)
      || (schema as Record<string, unknown>).type !== 'object') {
      throw new MachineInputError('outputSchema must be an object-rooted JSON Schema')
    }
  }
  return input as unknown as MachineRequest
}

/** A machine run never invents an exit code, usage, effective effort, or dollar cost. */
export async function runMachine(value: MachineRequest, options: MachineOptions = {}): Promise<MachineReceipt> {
  const request = parseMachineRequest(value)
  if (process.platform === 'win32') throw new MachineInputError('machine execution requires POSIX process-group supervision')
  const requested = {
    cwd: request.cwd, model: request.model, effort: request.effort,
    permissionMode: request.permissionMode, threadId: request.threadId ?? null,
  }
  const spec: CodexRunSpec = {
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
    ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  }
  try {
    const run = await startCodexRun([{ type: 'text', text: request.prompt }], spec, options.signal ?? new AbortController().signal)
    const outcome = await run.result
    return {
      protocol: 1, type: 'result', requestId: request.requestId, runId: run.id,
      ok: outcome.stopReason === 'completed' && outcome.cleanup.confirmed,
      requested, outcome, failure: null, costUSD: null, costStatus: 'unknown',
    }
  } catch (error: unknown) {
    const failure = error instanceof CodexRunFailure ? error : undefined
    return {
      protocol: 1, type: 'result', requestId: request.requestId,
      runId: failure?.execution?.runId ?? randomUUID(), ok: false, requested, outcome: null,
      failure: {
        stage: failure?.facts.stage ?? 'initialize', category: failure?.facts.category ?? 'runtime',
        diagnostic: failure?.message ?? 'codex-pro: run could not be initialized',
        execution: failure?.execution ?? null,
        configuration: failure?.configuration ?? null,
        usage: failure?.usage ?? null,
        rateLimits: failure?.rateLimits ?? null,
        turnConfiguration: failure?.turnConfiguration ?? null,
        cleanup: failure?.cleanup ?? null,
      },
      costUSD: null, costStatus: 'unknown',
    }
  }
}

export type { CodexRunOutcome } from './run.ts'

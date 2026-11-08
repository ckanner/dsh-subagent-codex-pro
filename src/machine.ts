/** Versioned, host-independent entry point for deterministic orchestrators. */
import { isAbsolute } from 'node:path'
import type { CodexRunFailure, CodexRunOutcome } from './run.ts'
import { runMachineLocal } from './machine-local.ts'
import { superviseMachine } from './machine-supervision.ts'
import { validateRecoveryDirectory, type MachineLifecycleEvent } from './machine-recovery.ts'

export { MACHINE_LIFECYCLE_VERSION, MACHINE_LIFECYCLE_CAPABILITIES, recoverMachine } from './machine-recovery.ts'
export type { MachineLifecycleEvent, MachineRecoveryRequest, MachineRecoveryReceipt } from './machine-recovery.ts'

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
  /** Returning resolves the caller's durable checkpoint ACK. Rejection stops dispatch. */
  readonly onLifecycle?: (event: MachineLifecycleEvent) => Promise<void> | void
  /** A NEW private directory; its canonical parent must already exist. Never reused. */
  readonly recoveryDirectory?: string
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
  if (key === 'requestId' && Buffer.byteLength(value) > 4096) throw new MachineInputError('requestId exceeds 4096 bytes')
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
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['signal', 'env', 'onProgress', 'onLifecycle', 'recoveryDirectory'].includes(key))) {
    throw new MachineInputError('machine options contain unsupported fields')
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new MachineInputError('signal must be an AbortSignal')
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw new MachineInputError('onProgress must be a function')
  if (options.env !== undefined && (options.env === null || typeof options.env !== 'object' || Array.isArray(options.env)
    || Object.values(options.env).some(value => value !== undefined && (typeof value !== 'string' || value.includes('\0'))))) {
    throw new MachineInputError('env must contain only string environment values')
  }
  if (options.onLifecycle !== undefined && typeof options.onLifecycle !== 'function') throw new MachineInputError('onLifecycle must be a function')
  if (options.recoveryDirectory !== undefined) {
    try { validateRecoveryDirectory(options.recoveryDirectory) } catch { throw new MachineInputError('invalid recoveryDirectory') }
  }
  if (options.onLifecycle !== undefined || options.recoveryDirectory !== undefined) return superviseMachine(request, options)
  return runMachineLocal(request, options)
}

export type { CodexRunOutcome } from './run.ts'

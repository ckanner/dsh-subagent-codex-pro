/** Private, durable evidence for one explicitly identified machine invocation. */
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import type { MachineReceipt } from './machine.ts'

export const MACHINE_LIFECYCLE_VERSION = 1 as const
export const MACHINE_LIFECYCLE_CAPABILITIES = Object.freeze({
  version: 1 as const, durableJournal: true, readOnlyRecovery: true, threadReadyBeforeDispatch: true,
})

export interface MachineLifecycleEvent {
  readonly lifecycleVersion: 1
  readonly type: 'lifecycle'
  readonly requestId: string
  readonly runId: string
  readonly sequence: number
  readonly event: 'thread-ready' | 'dispatch-intent' | 'dispatch-possible' | 'turn-accepted' | 'terminal' | 'cleanup-confirmed'
  readonly threadId: string | null
  readonly turnId: string | null
  /** Requested history mode; thread-ready configuration carries the backend evidence. */
  readonly persistent: boolean
  readonly configuration: Readonly<Record<string, unknown>> | null
  readonly dispatch: 'not-dispatched' | 'possible' | 'accepted'
  readonly outcome: 'unknown' | 'completed' | 'failed' | 'cancelled'
  readonly cleanupConfirmed: boolean
}

export interface MachineRecoveryRequest {
  readonly protocol: 1
  readonly requestId: string
  readonly runId: string
  readonly recoveryDirectory: string
}

export interface MachineRecoveryReceipt {
  readonly protocol: 1
  readonly type: 'recovery'
  readonly requestId: string
  readonly runId: string
  readonly status: 'terminal' | 'pending' | 'unknown'
  readonly receipt: MachineReceipt | null
  readonly lifecycle: MachineLifecycleEvent | null
  readonly reason: string
}

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024
const RECORD_NAME = 'machine-journal.json'
const EVENTS = new Set(['thread-ready', 'dispatch-intent', 'dispatch-possible', 'turn-accepted', 'terminal', 'cleanup-confirmed'])

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\0') && Buffer.byteLength(value) <= 4096
}

/** A recovery path is deliberately not a search root, an alias or a symlink. */
export function validateRecoveryDirectory(value: unknown, existing = false): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || normalize(value) !== value
    || value === dirname(value) || realpathSync(dirname(value)) !== dirname(value)) {
    throw new Error('recoveryDirectory must be a canonical absolute path with an existing physical parent')
  }
  if (existing) {
    const stat = lstatSync(value)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error('recoveryDirectory must be a private owned directory, not a symlink')
    }
  }
}

export function validLifecycle(value: unknown, requestId: string, runId: string): value is MachineLifecycleEvent {
  if (!object(value) || value.lifecycleVersion !== 1 || value.type !== 'lifecycle'
    || value.requestId !== requestId || value.runId !== runId || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 1 || !EVENTS.has(value.event as string)
    || (value.threadId !== null && !identity(value.threadId)) || (value.turnId !== null && !identity(value.turnId))
    || typeof value.persistent !== 'boolean' || (value.configuration !== null && !object(value.configuration))
    || !['not-dispatched', 'possible', 'accepted'].includes(value.dispatch as string)
    || !['unknown', 'completed', 'failed', 'cancelled'].includes(value.outcome as string)
    || typeof value.cleanupConfirmed !== 'boolean') return false
  if (value.event === 'thread-ready' && (value.dispatch !== 'not-dispatched' || value.threadId === null
    || !object(value.configuration) || value.configuration.matched !== true)) return false
  if (value.event === 'dispatch-intent' && value.dispatch !== 'not-dispatched') return false
  if (value.event === 'dispatch-possible' && value.dispatch !== 'possible') return false
  if (value.event === 'turn-accepted' && value.dispatch !== 'accepted') return false
  return value.event !== 'cleanup-confirmed' || value.cleanupConfirmed === true
}

interface JournalBody {
  readonly protocol: 1
  readonly type: 'machine-journal'
  readonly requestId: string
  readonly runId: string
  readonly lifecycle: MachineLifecycleEvent | null
  readonly receipt: MachineReceipt | null
}

function checksum(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

/** One writer, exclusive directory admission, atomic replacement and directory fsync. */
export class MachineJournal {
  readonly #directory: string
  #body: JournalBody
  constructor(directory: string, requestId: string, runId: string) {
    validateRecoveryDirectory(directory)
    // EEXIST is a refusal, never an invitation to rerun or replace old evidence.
    mkdirSync(directory, { mode: 0o700 })
    const parent = openSync(dirname(directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(parent) } finally { closeSync(parent) }
    this.#directory = directory
    this.#body = { protocol: 1, type: 'machine-journal', requestId, runId, lifecycle: null, receipt: null }
    this.#write()
  }
  lifecycle(event: MachineLifecycleEvent): void {
    if (!validLifecycle(event, this.#body.requestId, this.#body.runId)
      || event.sequence !== (this.#body.lifecycle?.sequence ?? 0) + 1) throw new Error('invalid lifecycle journal sequence')
    this.#body = { ...this.#body, lifecycle: event }
    this.#write()
  }
  receipt(receipt: MachineReceipt): void {
    if (receipt.protocol !== 1 || receipt.type !== 'result' || receipt.requestId !== this.#body.requestId
      || receipt.runId !== this.#body.runId || this.#body.receipt !== null) throw new Error('invalid terminal journal identity')
    this.#body = { ...this.#body, receipt }
    this.#write()
  }
  #write(): void {
    validateRecoveryDirectory(this.#directory, true)
    const data = JSON.stringify({ body: this.#body, sha256: checksum(this.#body) }) + '\n'
    if (Buffer.byteLength(data) > MAX_JOURNAL_BYTES) throw new Error('machine journal exceeds its bounded size')
    const temporary = join(this.#directory, '.pending-' + randomUUID())
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      renameSync(temporary, join(this.#directory, RECORD_NAME))
      const directory = openSync(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { try { unlinkSync(temporary) } catch { /* already renamed or retained evidence */ } }
  }
}

/** Read exactly one owned journal. Never starts a process, contacts a model or changes files. */
export async function recoverMachine(value: MachineRecoveryRequest): Promise<MachineRecoveryReceipt> {
  if (!object(value) || Object.keys(value).some(key => !['protocol', 'requestId', 'runId', 'recoveryDirectory'].includes(key))
    || value.protocol !== 1 || !identity(value.requestId) || !identity(value.runId)
    || typeof value.recoveryDirectory !== 'string' || !isAbsolute(value.recoveryDirectory)
    || value.recoveryDirectory.includes('\0')) throw new Error('invalid machine recovery request')
  const base = { protocol: 1 as const, type: 'recovery' as const, requestId: value.requestId, runId: value.runId }
  const unknown = (reason: string): MachineRecoveryReceipt => ({ ...base, status: 'unknown', receipt: null, lifecycle: null, reason })
  try {
    validateRecoveryDirectory(value.recoveryDirectory, true)
    const file = join(value.recoveryDirectory, RECORD_NAME)
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    let data: unknown
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES || (stat.mode & 0o077) !== 0
        || (process.getuid !== undefined && stat.uid !== process.getuid())) return unknown('untrusted journal file')
      data = JSON.parse(readFileSync(fd, 'utf8')) as unknown
    } finally { closeSync(fd) }
    if (!object(data) || !object(data.body) || data.sha256 !== checksum(data.body)) return unknown('invalid journal integrity')
    const body = data.body
    if (body.protocol !== 1 || body.type !== 'machine-journal' || body.requestId !== value.requestId || body.runId !== value.runId
      || (body.lifecycle !== null && !validLifecycle(body.lifecycle, value.requestId, value.runId))) return unknown('journal identity does not match')
    const lifecycle = body.lifecycle as MachineLifecycleEvent | null
    if (body.receipt === null) return { ...base, status: 'pending', receipt: null, lifecycle,
      reason: 'no durable terminal receipt; owner liveness, execution outcome and replay safety remain unproven' }
    const receipt = body.receipt
    if (!object(receipt) || receipt.protocol !== 1 || receipt.type !== 'result'
      || receipt.requestId !== value.requestId || receipt.runId !== value.runId || typeof receipt.ok !== 'boolean') {
      return unknown('invalid terminal receipt identity')
    }
    return { ...base, status: 'terminal', receipt: receipt as unknown as MachineReceipt, lifecycle,
      reason: 'original durable receipt; caller must validate its configuration, outcome and independent cleanup facts' }
  } catch { return unknown('journal absent, inaccessible or malformed; no replay is authorized') }
}

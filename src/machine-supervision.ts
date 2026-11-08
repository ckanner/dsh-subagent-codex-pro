/** A machine supervisor owns terminal persistence even after its API caller dies. */
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { MachineOptions, MachineReceipt, MachineRequest } from './machine.ts'
import { validLifecycle } from './machine-recovery.ts'

export interface MachineHostOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly recoveryDirectory?: string
}

/** This promise rejects on incomplete evidence; it never fabricates a successful receipt. */
export async function superviseMachine(request: MachineRequest, options: MachineOptions): Promise<MachineReceipt> {
  const runId = randomUUID()
  const host = fork(fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './machine-supervisor.ts' : './machine-supervisor.js', import.meta.url)), [], {
    execPath: process.execPath, execArgv: [], detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {},
  })
  let settled = false, ready = false, receipt: MachineReceipt | undefined, failure: Error | undefined
  let lastSequence = 0
  let exitDrain: NodeJS.Timeout | undefined
  let resolveClosed: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const send = (message: Record<string, unknown>): void => {
    if (!host.connected) return
    try { host.send({ protocol: 1, runId, ...message }, error => { if (error !== null) disconnect() }) } catch { disconnect() }
  }
  const disconnect = (): void => {
    try { if (host.connected) host.disconnect() } catch { /* The inherited lease is already closed. */ }
  }
  const invalid = (reason: string): void => {
    failure ??= new Error(reason)
    send({ type: 'cancel' })
    disconnect()
  }
  const cancel = (): void => { send({ type: 'cancel' }) }
  options.signal?.addEventListener('abort', cancel, { once: true })
  const admissionTimer = setTimeout(() => { invalid('machine supervisor admission timed out') }, 10_000)
  host.stderr?.on('data', () => { /* Drained, never mistaken for structured lifecycle or exposed as credentials. */ })
  const settleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return
    settled = true
    clearTimeout(admissionTimer)
    if (exitDrain !== undefined) clearTimeout(exitDrain)
    options.signal?.removeEventListener('abort', cancel)
    if (code !== 0 || signal !== null) failure ??= new Error('machine supervisor exited without a complete normal handoff')
    resolveClosed()
  }
  host.once('error', () => { invalid('machine supervisor could not start'); if (host.pid === undefined) settleExit(null, null) })
  host.once('close', settleExit)
  host.once('exit', (code, signal) => {
    // A simultaneous IPC disconnect can suppress ChildProcess 'close' on some
    // Node versions. The OS exit is authoritative for this supervisor; allow a
    // bounded IPC drain, then stop waiting on an already-dead process.
    exitDrain = setTimeout(() => { host.stderr?.destroy(); settleExit(code, signal) }, 250)
  })
  host.on('message', (raw: unknown) => {
    if (settled || failure !== undefined) return
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { invalid('invalid machine supervisor message'); return }
    const message = raw as Record<string, unknown>
    if (message.protocol !== 1 || (message.type !== 'ready' && message.runId !== runId)) { invalid('machine supervisor identity mismatch'); return }
    if (message.type === 'ready') {
      if (ready) { invalid('duplicate machine supervisor admission'); return }
      ready = true
      clearTimeout(admissionTimer)
      const env = { ...process.env, ...options.env }
      send({ type: 'start', request, options: { env,
        ...(options.recoveryDirectory === undefined ? {} : { recoveryDirectory: options.recoveryDirectory }) } })
      if (options.signal?.aborted === true) cancel()
      return
    }
    if (!ready || receipt !== undefined) { invalid('machine supervisor message out of order'); return }
    if (message.type === 'lifecycle') {
      const event = message.event
      if (!validLifecycle(event, request.requestId, runId) || event.sequence !== lastSequence + 1) {
        invalid('machine supervisor lifecycle mismatch'); return
      }
      lastSequence = event.sequence
      // Rejection is an explicit negative ACK. The host aborts before a turn can
      // cross a pre-dispatch barrier; a final receipt remains intact after cleanup.
      void Promise.resolve().then(() => options.onLifecycle?.(event)).then(
        () => { send({ type: 'ack', sequence: event.sequence, ok: true }) },
        () => { send({ type: 'ack', sequence: event.sequence, ok: false }) },
      )
    } else if (message.type === 'progress' && typeof message.text === 'string') {
      try { options.onProgress?.(message.text) } catch { /* Progress is display-only. */ }
    } else if (message.type === 'result') {
      const value = message.receipt
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { invalid('invalid machine supervisor receipt'); return }
      const result = value as MachineReceipt
      if (result.protocol !== 1 || result.type !== 'result' || result.requestId !== request.requestId
        || result.runId !== runId || typeof result.ok !== 'boolean') { invalid('machine supervisor terminal identity mismatch'); return }
      receipt = result
    } else if (message.type === 'failure') {
      failure = new Error('machine supervisor could not persist or deliver complete invocation evidence')
      disconnect()
    } else invalid('unsupported machine supervisor message')
  })
  await closed
  if (failure !== undefined) throw failure
  if (receipt === undefined) throw new Error('machine supervisor closed without a terminal receipt; recover the known journal before replay')
  return receipt
}

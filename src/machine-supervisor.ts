/** Private supervised machine host. Native cleanup and journal completion outlive the caller. */
import { runMachineLocal } from './machine-local.ts'
import type { MachineRequest } from './machine.ts'
import { MachineJournal, type MachineLifecycleEvent } from './machine-recovery.ts'
import type { MachineHostOptions } from './machine-supervision.ts'

const abort = new AbortController()
let started = false, finished = false, runId: string | undefined
let acknowledgement: { sequence: number; resolve(): void; reject(error: Error): void } | undefined
const cancel = (): void => {
  abort.abort()
  acknowledgement?.reject(new Error('machine caller disconnected or cancelled'))
  acknowledgement = undefined
}
for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(event, cancel)
process.on('disconnect', cancel)

function send(message: Record<string, unknown>): Promise<boolean> {
  return new Promise(resolve => {
    if (!process.connected || process.send === undefined) { resolve(false); return }
    try {
      process.send({ protocol: 1, runId, ...message }, error => {
        if (error !== null) cancel()
        resolve(error === null)
      })
    } catch { cancel(); resolve(false) }
  })
}

const admissionTimer = setTimeout(() => {
  if (!started) { cancel(); if (process.connected) process.disconnect(); process.exitCode = 1 }
}, 10_000)
process.on('disconnect', () => { if (!started) { clearTimeout(admissionTimer); process.exitCode = 0 } })

process.on('message', (raw: unknown) => {
  if (finished) return
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { cancel(); return }
  const message = raw as Record<string, unknown>
  if (message.protocol !== 1 || (started && message.runId !== runId)) { cancel(); return }
  if (message.type === 'cancel') { cancel(); return }
  if (message.type === 'ack') {
    if (acknowledgement === undefined || message.sequence !== acknowledgement.sequence || typeof message.ok !== 'boolean') { cancel(); return }
    const pending = acknowledgement
    acknowledgement = undefined
    if (message.ok) pending.resolve()
    else { pending.reject(new Error('machine lifecycle checkpoint was rejected')); abort.abort() }
    return
  }
  if (started || message.type !== 'start' || typeof message.runId !== 'string') { cancel(); return }
  started = true
  runId = message.runId
  clearTimeout(admissionTimer)
  void execute(message.request as MachineRequest, message.options as MachineHostOptions)
})

async function execute(request: MachineRequest, options: MachineHostOptions): Promise<void> {
  try {
    if (!process.connected) cancel()
    const journal = options.recoveryDirectory === undefined ? undefined : new MachineJournal(options.recoveryDirectory, request.requestId, runId!)
    const onLifecycle = async (event: MachineLifecycleEvent): Promise<void> => {
      journal?.lifecycle(event)
      if (!process.connected || abort.signal.aborted) throw new Error('machine caller is no longer awaiting this checkpoint')
      const ack = new Promise<void>((resolve, reject) => { acknowledgement = { sequence: event.sequence, resolve, reject } })
      // Attach the handler before a send can synchronously trigger disconnect.
      const waiting = ack.catch((error: unknown) => { throw error })
      waiting.catch(() => {})
      const timeout = setTimeout(cancel, 10_000)
      try {
        if (!await send({ type: 'lifecycle', event })) cancel()
        await waiting
      } finally { clearTimeout(timeout) }
    }
    const receipt = await runMachineLocal(request, {
      signal: abort.signal, env: options.env as Readonly<Record<string, string>>, onLifecycle,
      onNativeEvent: event => { void send({ type: 'native-event', event }) },
      onProgress: text => { void send({ type: 'progress', text: text.slice(0, 16_384) }) },
    }, runId!, value => { journal?.receipt(value) })
    await send({ type: 'result', receipt })
  } catch {
    await send({ type: 'failure' })
  } finally {
    finished = true
    acknowledgement?.reject(new Error('machine supervisor completed'))
    acknowledgement = undefined
    if (process.connected) process.disconnect()
    process.exitCode = 0
  }
}

await send({ type: 'ready' })

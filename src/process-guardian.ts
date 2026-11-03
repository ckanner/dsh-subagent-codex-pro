/**
 * Private POSIX group guardian for one Codex app-server.
 *
 * The caller creates this process as a group leader and establishes the IPC
 * lifeline in the same spawn operation. Codex inherits this group, but never
 * the IPC descriptor. An abruptly killed caller therefore closes the lifeline
 * even if Codex is hung, before or after initialization. The guardian then
 * terminates only its own group with a finite TERM/KILL sequence.
 *
 * Normal cleanup is confirmed by the surviving caller with kill(-pgid, 0).
 * Emergency cleanup cannot write a final receipt after killing this guardian;
 * missing app-server exit facts must remain unknown in the caller's receipt.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync } from 'node:fs'

const command = process.argv[2]
const graceMs = Number(process.argv[3])
const posix = process.platform !== 'win32'
let child: ChildProcess | undefined
let stopping = false

function closeProtocolDescriptors(): void {
  // Let the caller observe EOF after all app-server output has drained. Keep
  // only our private IPC lease; Codex descendants may still hold their copies.
  for (const fd of [0, 1, 2]) {
    try { closeSync(fd) } catch { /* already closed */ }
  }
}

function beginShutdown(): void {
  if (stopping) return
  stopping = true
  // Set the guard before signaling this group: SIGTERM also reaches us.
  try {
    if (posix) process.kill(-process.pid, 'SIGTERM')
    else child?.kill('SIGTERM')
  } catch { /* The caller independently checks its owned group. */ }
  setTimeout(() => {
    try {
      if (posix) process.kill(-process.pid, 'SIGKILL')
      else child?.kill('SIGKILL')
    } finally {
      // SIGKILL above is synchronous on POSIX; Windows has no group guarantee.
      process.exit(1)
    }
  }, graceMs)
}

function report(message: Record<string, unknown>): void {
  if (!process.connected || process.send === undefined) {
    beginShutdown()
    return
  }
  try {
    process.send(message, (error: Error | null) => {
      if (error !== null) beginShutdown()
    })
  } catch {
    beginShutdown()
  }
}

// Install the handlers before starting any work. A parent can die before this
// module starts executing; checking connected also covers that missed event.
process.on('disconnect', beginShutdown)
process.on('SIGTERM', beginShutdown)
process.on('SIGINT', beginShutdown)

if (command === undefined || !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30_000) {
  report({ type: 'spawn-error', message: 'invalid private guardian arguments' })
  beginShutdown()
} else if (!process.connected) {
  beginShutdown()
} else {
  const env = { ...process.env }
  delete env.NODE_CHANNEL_FD
  delete env.NODE_CHANNEL_SERIALIZATION_MODE
  try {
    child = spawn(command, ['app-server', '--stdio'], {
      cwd: process.cwd(), env, stdio: ['inherit', 'inherit', 'inherit'],
      detached: false, windowsHide: true,
    })
    child.once('spawn', () => { report({ type: 'started', pid: child?.pid }) })
    child.once('error', (error) => {
      report({ type: 'spawn-error', message: error.message })
      closeProtocolDescriptors()
    })
    child.once('exit', (exitCode, signal) => {
      report({ type: 'exit', exitCode, signal })
      closeProtocolDescriptors()
    })
    // No process.exit here: a descendant may outlive the app-server. The
    // guardian must retain group ownership until caller cleanup or IPC EOF.
  } catch (error: unknown) {
    report({ type: 'spawn-error', message: error instanceof Error ? error.message : String(error) })
  }
  if (!process.connected) beginShutdown()
}

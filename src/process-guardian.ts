/**
 * Private POSIX group guardian for one Codex app-server.
 *
 * The caller creates this process as a group leader and establishes the IPC
 * lifeline in the same spawn operation. Codex inherits this group, but never
 * the IPC descriptor. An abruptly killed caller therefore closes the lifeline
 * even if Codex is hung, before or after initialization. The guardian then
 * terminates only its own group with a finite TERM/KILL sequence.
 *
 * A live caller can request a normal stop with SIGTERM/SIGINT. In that case the
 * caller keeps ownership and confirms the group itself, so this process exits
 * as soon as the app-server exits instead of making every normal delegation
 * sleep the whole dispose grace. A caller death (IPC disconnect) keeps the
 * full grace: there the guardian is the last group owner and must clean up
 * descendants that outlive the app-server.
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

type ShutdownReason = 'caller' | 'disconnect'

let child: ChildProcess | undefined
let stopping = false
let callerGone = false
let callerRequestedStop = false
let childDone = false
let exiting = false

function closeProtocolDescriptors(): void {
  // Let the caller observe EOF after all app-server output has drained. Keep
  // only our private IPC lease; Codex descendants may still hold their copies.
  for (const fd of [0, 1, 2]) {
    try { closeSync(fd) } catch { /* already closed */ }
  }
}

function exitAfterCallerStop(): void {
  if (exiting || callerGone || !callerRequestedStop || !childDone) return
  exiting = true
  // Let the exit IPC frame reach the caller. The grace timer remains armed:
  // if the caller disappears in this window, the guardian must keep owning
  // the group until the timer's SIGKILL instead of exiting early.
  setImmediate(() => {
    if (callerGone || !callerRequestedStop || !childDone) {
      exiting = false
      return
    }
    process.exit(0)
  })
}

function beginShutdown(reason: ShutdownReason): void {
  if (reason === 'caller') callerRequestedStop = true
  else callerGone = true
  if (stopping) {
    exitAfterCallerStop()
    return
  }
  stopping = true
  // Set the guard before signaling this group: SIGTERM also reaches us.
  try {
    if (posix) process.kill(-process.pid, 'SIGTERM')
    else child?.kill('SIGTERM')
  } catch { /* The caller independently checks its owned group. */ }
  if (callerRequestedStop && !callerGone && childDone) {
    exitAfterCallerStop()
    return
  }
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

function report(message: Record<string, unknown>, afterSend?: () => void): void {
  if (!process.connected || process.send === undefined) {
    afterSend?.()
    beginShutdown('disconnect')
    return
  }
  try {
    process.send(message, (error: Error | null) => {
      if (error !== null) {
        beginShutdown('disconnect')
        return
      }
      afterSend?.()
    })
  } catch {
    beginShutdown('disconnect')
  }
}

// Install the handlers before starting any work. A parent can die before this
// module starts executing; checking connected also covers that missed event.
process.on('disconnect', () => { beginShutdown('disconnect') })
process.on('SIGTERM', () => { beginShutdown('caller') })
process.on('SIGINT', () => { beginShutdown('caller') })

if (command === undefined || !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30_000) {
  childDone = true
  report({ type: 'spawn-error', message: 'invalid private guardian arguments' })
  beginShutdown('disconnect')
} else if (!process.connected) {
  beginShutdown('disconnect')
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
      childDone = true
      closeProtocolDescriptors()
      report({ type: 'spawn-error', message: error.message }, () => { exitAfterCallerStop() })
    })
    child.once('exit', (exitCode, signal) => {
      childDone = true
      closeProtocolDescriptors()
      report({ type: 'exit', exitCode, signal }, () => { exitAfterCallerStop() })
    })
    // No immediate process.exit here: when the caller is alive it will request
    // cleanup. If the caller dies, the IPC disconnect handler keeps the full
    // grace to own and terminate descendants. A caller-requested stop exits
    // from the exit/error callbacks above once the app-server is gone.
  } catch (error: unknown) {
    childDone = true
    report({ type: 'spawn-error', message: error instanceof Error ? error.message : String(error) },
      () => { exitAfterCallerStop() })
  }
  if (!process.connected) beginShutdown('disconnect')
}

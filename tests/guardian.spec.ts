/**
 * Guardian shutdown latency and lifeline behavior.
 *
 * The guardian must not make every normal delegation sleep the full dispose
 * grace after Codex has exited. It must still retain the full grace when the
 * caller disappears, because then it is the last owner of the process group.
 *
 * @module dsh-subagent-codex-pro/tests/guardian
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const posix = process.platform !== 'win32'

/** Spawn the private guardian with a child that exits on SIGTERM. */
function startGuardian(graceMs: number): {
  readonly pid: number
  readonly started: Promise<void>
  readonly exited: Promise<number | null>
  readonly killGroup: () => void
} {
  const guardian = spawn(process.execPath, [
    fileURLToPath(new URL('../src/process-guardian.ts', import.meta.url)),
    fileURLToPath(new URL('./fixtures/guardian-child.mjs', import.meta.url)),
    String(graceMs),
  ], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const pid = guardian.pid
  assert.ok(pid !== undefined)
  let startedResolve!: () => void
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  guardian.on('message', (message: unknown) => {
    if (message !== null && typeof message === 'object'
      && (message as { type?: unknown }).type === 'started') startedResolve()
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    guardian.once('error', reject)
    guardian.once('close', (code) => resolve(code))
  })
  return {
    pid,
    started,
    exited,
    killGroup: () => {
      for (const signal of ['SIGKILL'] as const) {
        try { process.kill(-pid, signal) } catch { /* already gone */ }
        try { process.kill(pid, signal) } catch { /* already gone */ }
      }
    },
  }
}

test('a caller-requested guardian stop exits promptly after the app-server', { skip: !posix, timeout: 10_000 }, async () => {
  const guardian = startGuardian(5_000)
  try {
    await guardian.started
    const startedAt = performance.now()
    // Simulate the live caller's normal teardown: signal the whole group.
    process.kill(-guardian.pid, 'SIGTERM')
    const code = await guardian.exited
    const elapsed = performance.now() - startedAt
    assert.equal(code, 0)
    // The child exits on SIGTERM; the old code slept the full 5 s grace.
    assert.ok(elapsed < 1_500, `guardian waited ${String(Math.round(elapsed))}ms for a 5000ms grace`)
    assert.throws(() => process.kill(-guardian.pid, 0), /ESRCH/)
  } finally {
    guardian.killGroup()
  }
})

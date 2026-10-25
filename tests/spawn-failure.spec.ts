/**
 * A delegation whose Codex executable is missing.
 *
 * The failure has two parts. The delegation must reject with a normal run
 * failure instead of hanging, and nothing in the cleanup path may leave an
 * unhandled rejection behind: the Host escalates that to a fatal load failure
 * and exits, so one bad `PATH` takes every running session down with it.
 *
 * @module dsh-subagent-codex-pro/tests
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startCodexRun, type CodexRunSpec } from '../src/run.ts'

/** An executable name no platform ships. */
const MISSING = 'dsh-codex-pro-missing-executable-4f9a2c'

test('a missing Codex executable fails the run without an unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const spec: CodexRunSpec = {
      cwd: process.cwd(),
      command: MISSING,
      permissionMode: 'never',
      threadMode: 'ephemeral',
      runTimeoutMs: 5000,
    }
    await assert.rejects(
      startCodexRun([{ type: 'text', text: 'probe' }], spec, new AbortController().signal),
      (error: unknown) => error instanceof Error,
    )
    // The spawn error is delivered on a later tick. Give a leaked rejection the
    // chance to surface before asserting the cleanup path was quiet.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

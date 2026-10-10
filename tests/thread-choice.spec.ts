/**
 * The thread a call continues.
 *
 * This is the policy that keeps `session` mode from handing one thread to two
 * delegations at once. It is a pure function so the decision can be tested
 * without an app-server: the failure it prevents was measured against a real
 * one, where the second of two concurrent calls died at `thread/resume` with
 * `thread-store conflict: … already has an active writer`.
 *
 * @module dsh-subagent-codex-pro/tests/thread-choice
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const { chooseThread } = await import('../src/run.ts')

const none: ReadonlySet<string> = new Set<string>()

test('an explicit id is always continued, even while another call uses it', () => {
  // Continuing that thread is the request; running somewhere else would answer a
  // different question, so this is the one case the busy check must not touch.
  assert.deepEqual(
    chooseThread({ explicit: 'thread-1', configured: 'session', remembered: 'thread-2', inFlight: new Set(['thread-1']) }),
    { reuse: 'thread-1', skippedBusy: undefined },
  )
  assert.deepEqual(
    chooseThread({ explicit: 'thread-9', configured: 'ephemeral', remembered: undefined, inFlight: none }),
    { reuse: 'thread-9', skippedBusy: undefined },
  )
})

test('session mode continues the remembered thread while it is idle', () => {
  assert.deepEqual(
    chooseThread({ explicit: undefined, configured: 'session', remembered: 'thread-1', inFlight: none }),
    { reuse: 'thread-1', skippedBusy: undefined },
  )
})

test('session mode skips its thread while another delegation holds it, and says so', () => {
  const choice = chooseThread({
    explicit: undefined,
    configured: 'session',
    remembered: 'thread-1',
    inFlight: new Set(['thread-1']),
  })
  assert.deepEqual(choice, { reuse: undefined, skippedBusy: 'thread-1' })
  // The caller runs, in its own thread: this is a downgrade, not a failure.
  assert.notEqual(choice.reuse, 'thread-1')
})

test('session mode with nothing remembered yet starts a thread', () => {
  assert.deepEqual(
    chooseThread({ explicit: undefined, configured: 'session', remembered: undefined, inFlight: none }),
    { reuse: undefined, skippedBusy: undefined },
  )
})

test('the other modes never continue a remembered thread', () => {
  for (const configured of ['ephemeral', 'persistent'] as const) {
    assert.deepEqual(
      chooseThread({ explicit: undefined, configured, remembered: 'thread-1', inFlight: none }),
      { reuse: undefined, skippedBusy: undefined },
      `${configured} must not reuse a remembered thread`,
    )
  }
})

test('a busy thread in another mode is not reported as skipped', () => {
  // Only session mode was going to reuse it, so only session mode can skip it.
  assert.deepEqual(
    chooseThread({ explicit: undefined, configured: 'persistent', remembered: 'thread-1', inFlight: new Set(['thread-1']) }),
    { reuse: undefined, skippedBusy: undefined },
  )
})

test('an explicit thread id wins over a caller-named directory', () => {
  // Measured: a thread created in A, resumed with cwd B, still answered with A
  // and still remembered A's conversation. So an explicit id is always honored,
  // and the cwd only decides where a *new* thread is created.
  assert.deepEqual(
    chooseThread({ explicit: 'thread-a', configured: 'session', remembered: 'thread-b', inFlight: new Set(['thread-a']) }),
    { reuse: 'thread-a', skippedBusy: undefined },
  )
})

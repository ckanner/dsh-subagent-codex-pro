/**
 * Real runs over the app-server protocol.
 *
 * Skipped unless `CODEX_SUBAGENT_LIVE=1`, so the default suite stays hermetic.
 * These cases prove the port against the installed CLI: a real
 * `codex app-server --stdio` child, the initialize handshake, a thread opened
 * with the requested model/permission policy, a turn carrying a per-turn
 * effort, structured output enforcement, a persistent thread resumed with
 * explicit overrides, and the usage/cleanup facts this hardening added.
 *
 * @module dsh-subagent-codex-pro/tests/live
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

import { delegateOnce } from '../src/run.ts'

const live = process.env.CODEX_SUBAGENT_LIVE === '1'

/** Every real run must report a confirmed process range and configuration. */
function assertObservability(outcome: {
  readonly usage: { readonly status: string }
  readonly cleanup: { readonly confirmed: boolean }
  readonly configuration?: unknown
}): void {
  assert.equal(outcome.cleanup.confirmed, true)
  assert.notEqual(outcome.usage.status, 'unknown', 'the app-server did not report token usage')
  assert.ok(outcome.configuration !== undefined)
}

test('a real app-server run carries the model and the effort', { skip: !live }, async () => {
  const outcome = await delegateOnce({
    prompt: 'Reply with exactly: PROBE_OK',
    cwd: tmpdir(),
    command: 'codex',
    permissionMode: 'dangerously-bypass-approvals-and-sandbox',
    model: 'gpt-6-astra',
    reasoningEffort: 'xhigh',
    signal: new AbortController().signal,
  })
  assert.match(outcome.text, /PROBE_OK/)
  assertObservability(outcome)
  assert.ok((outcome.usage.run?.totalTokens ?? 0) > 0)
  assert.ok(outcome.threadId !== undefined)
})

test('a real app-server run completes without either choice', { skip: !live }, async () => {
  const outcome = await delegateOnce({
    prompt: 'Reply with exactly: DEFAULT_OK',
    cwd: tmpdir(),
    command: 'codex',
    permissionMode: 'never',
    signal: new AbortController().signal,
  })
  assert.match(outcome.text, /DEFAULT_OK/)
  assertObservability(outcome)
  assert.ok((outcome.usage.run?.totalTokens ?? 0) > 0)
})

test('a real persistent thread resumes with explicit model/cwd/read-only overrides', { skip: !live }, async () => {
  const first = await delegateOnce({
    prompt: 'Reply with exactly: FIRST_OK',
    cwd: tmpdir(),
    command: 'codex',
    permissionMode: 'dangerously-bypass-approvals-and-sandbox',
    model: 'gpt-6-astra',
    threadMode: 'persistent',
    threadName: 'DSH live resume probe',
    signal: new AbortController().signal,
  })
  assert.match(first.text, /FIRST_OK/)
  assert.ok(first.threadId !== undefined)
  assertObservability(first)

  const resumed = await delegateOnce({
    prompt: 'Reply with exactly: SECOND_OK',
    cwd: tmpdir(),
    command: 'codex',
    permissionMode: 'read-only',
    model: 'gpt-6-astra',
    threadMode: 'persistent',
    threadId: first.threadId,
    signal: new AbortController().signal,
  })
  assert.match(resumed.text, /SECOND_OK/)
  assert.equal(resumed.threadId, first.threadId)
  assertObservability(resumed)
  assert.equal(resumed.configuration?.matched, true)
  assert.equal(resumed.configuration?.effective.sandbox, 'read-only')
  assert.equal(resumed.usage.replayedBaseline, true)
  assert.ok((resumed.usage.run?.totalTokens ?? 0) > 0)
})

test('a real app-server run enforces and decodes output_schema', { skip: !live }, async () => {
  const outcome = await delegateOnce({
    prompt: 'Return exactly this JSON object and nothing else: {"verdict":"pass","count":2}',
    cwd: tmpdir(),
    command: 'codex',
    permissionMode: 'dangerously-bypass-approvals-and-sandbox',
    model: 'gpt-6-astra',
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'count'],
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        count: { type: 'integer', minimum: 0 },
      },
    },
    signal: new AbortController().signal,
  })
  assert.deepEqual(outcome.structured, { verdict: 'pass', count: 2 })
  assertObservability(outcome)
})

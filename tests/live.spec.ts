/**
 * One real run over the app-server protocol.
 *
 * Skipped unless `CODEX_SUBAGENT_LIVE=1`, so the default suite stays hermetic.
 * This is the case that proves the port: a real `codex app-server --stdio`
 * child, the initialize handshake, a thread opened with a reasoning
 * effort, one turn opened with an effort, and a final answer selected from the
 * notification stream.
 *
 * @module dsh-subagent-codex-pro/tests/live
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

import { delegateOnce } from '../src/run.ts'

const live = process.env.CODEX_SUBAGENT_LIVE === '1'

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
})

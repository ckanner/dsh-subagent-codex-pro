/**
 * Whole-lifecycle behavior against a real child process.
 *
 * The fake app-server is a real Node process, not an in-memory peer: it makes
 * the spawn/process-group/deadline/cleanup paths observable. It ignores SIGTERM
 * so tier escalation and confirmation are exercised, and one mode spawns a
 * descendant to prove cleanup owns the group rather than only the direct child.
 *
 * No model is called; every response is scripted.
 *
 * @module dsh-subagent-codex-pro/tests/lifecycle
 */

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  startCodexRun, runCodexOnce, delegateOnce, textTask, codexAppServerArgv,
  CodexRunFailure, CodexDelegationFailure, type CodexRunSpec,
} from '../src/run.ts'

const dirs: string[] = []
const pids: number[] = []

afterEach(() => {
  for (const pid of pids.splice(0)) {
    for (const signal of ['SIGKILL'] as const) {
      try { process.kill(-pid, signal) } catch { /* best effort */ }
      try { process.kill(pid, signal) } catch { /* already gone */ }
    }
  }
})

/** One scripted app-server process, created in a temporary directory. */
function fakeServer(mode: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pro-fake-'))
  dirs.push(dir)
  const command = join(dir, 'fake-codex')
  const script = `#!/usr/bin/env node
'use strict'
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const mode = ${JSON.stringify(mode)}
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n')
let buffer = ''
let threadId = 'thread-1'
let turnId = 'turn-1'
let child
if (mode === 'descendant') {
  child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
  if (process.env.FAKE_CHILD_PID_FILE) writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid))
}
process.on('SIGTERM', () => {})
function answerStart(params) {
  const sandbox = params.sandbox === 'read-only' ? { type: 'readOnly' }
    : params.sandbox === 'workspace-write' ? { type: 'workspaceWrite' }
    : params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : { type: 'workspaceWrite' }
  return {
    thread: { id: 'thread-1', ephemeral: params.ephemeral === true },
    model: params.model || 'gpt-6-astra',
    cwd: params.cwd || '/tmp',
    approvalPolicy: params.approvalPolicy || 'never',
    approvalsReviewer: params.approvalsReviewer || 'user',
    sandbox,
    reasoningEffort: null,
  }
}
function answerResume(params) {
  return answerStart({
    ...params,
    ephemeral: false,
    model: params.model,
    cwd: params.cwd,
    approvalPolicy: params.approvalPolicy,
    approvalsReviewer: params.approvalsReviewer,
    sandbox: params.sandbox,
  })
}
const breakdown = (n) => ({
  totalTokens: n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0,
})
function finishTurn(totalBefore, totalAfter, finalText) {
  if (totalBefore !== undefined) {
    notify('thread/tokenUsage/updated', {
      threadId, turnId: 'old-turn', tokenUsage: { total: breakdown(totalBefore), last: breakdown(totalBefore), modelContextWindow: 272000 },
    })
  }
  if (totalAfter !== undefined) {
    notify('thread/tokenUsage/updated', {
      threadId, turnId, tokenUsage: { total: breakdown(totalAfter), last: breakdown(totalAfter), modelContextWindow: 272000 },
    })
  }
  notify('item/completed', {
    threadId, turnId,
    item: { type: 'agentMessage', phase: 'final_answer', text: finalText || 'FINAL' },
  })
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
}
function handle(message) {
  if (message.method === 'initialized') return
  const params = message.params || {}
  if (message.method === 'initialize') {
    if (mode === 'hang-initialize') return
    reply(message.id, {})
    if (mode === 'exit-after-init') process.exit(0)
    return
  }
  if (message.method === 'thread/start') {
    if (mode === 'hang-thread') return
    if (mode === 'hang-name') {
      // create the thread and then hang on its name request
      threadId = 'thread-1'
      reply(message.id, answerStart({ ...params, ephemeral: false }))
      return
    }
    reply(message.id, answerStart(params))
    return
  }
  if (message.method === 'thread/resume') {
    threadId = params.threadId || 'thread-1'
    reply(message.id, answerResume(params))
    return
  }
  if (message.method === 'thread/name/set') {
    if (mode === 'hang-name') return
    reply(message.id, {})
    return
  }
  if (message.method === 'turn/start') {
    if (mode === 'usage-resume') {
      notify('thread/tokenUsage/updated', {
        threadId, turnId: 'old-turn',
        tokenUsage: { total: breakdown(1000), last: breakdown(1000), modelContextWindow: 272000 },
      })
    }
    reply(message.id, { turn: { id: turnId } })
    if (mode === 'hang-turn' || mode === 'descendant') return
    if (mode === 'usage-hang') {
      notify('thread/tokenUsage/updated', {
        threadId, turnId, tokenUsage: { total: breakdown(300), last: breakdown(300), modelContextWindow: 272000 },
      })
      return
    }
    if (mode === 'exit-after-turn-start') { setImmediate(() => process.exit(0)); return }
    if (mode === 'usage') { setImmediate(() => finishTurn(undefined, 300)); return }
    if (mode === 'usage-resume') { setImmediate(() => finishTurn(undefined, 1300)); return }
    if (mode === 'json') { setImmediate(() => finishTurn(undefined, undefined, '{"verdict":"pass","count":2}')); return }
    if (mode === 'bad-json') { setImmediate(() => finishTurn(undefined, undefined, 'not json')); return }
    setImmediate(() => finishTurn(undefined, undefined))
    return
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim() === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined) handle(message)
  }
})
setInterval(() => {}, 1000)
`
  writeFileSync(command, script)
  chmodSync(command, 0o755)
  return command
}

/** Wait for a promise to reject, with a bounded test deadline. */
async function rejectsWithin<T>(promise: Promise<T>, ms: number): Promise<Error> {
  return await Promise.race([
    promise.then(() => { throw new Error('the run unexpectedly resolved') }, (error: unknown) => error instanceof Error ? error : new Error(String(error))),
    new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new Error(`still pending after ${String(ms)}ms`)) }, ms) }),
  ])
}

test('a hung initialize is stopped by the total deadline', async () => {
  const command = fakeServer('hang-initialize')
  const started = Date.now()
  const error = await rejectsWithin(
    startCodexRun([{ type: 'text', text: 'probe' }], {
      cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 100, disposeGraceMs: 100,
    }, new AbortController().signal),
    10_000,
  )
  assert.ok(error instanceof CodexRunFailure, error.stack)
  assert.equal(error.facts.category, 'timeout')
  assert.ok(Date.now() - started < 4_000)
})

test('a hung thread/start is stopped by the total deadline', async () => {
  const command = fakeServer('hang-thread')
  const error = await rejectsWithin(
    startCodexRun([{ type: 'text', text: 'probe' }], {
      cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 100, disposeGraceMs: 100,
    }, new AbortController().signal),
    10_000,
  )
  assert.ok(error instanceof CodexRunFailure, error.stack)
  assert.equal(error.facts.category, 'timeout')
})

test('a hung thread name is stopped by the total deadline', async () => {
  const command = fakeServer('hang-name')
  const error = await rejectsWithin(
    startCodexRun([{ type: 'text', text: 'probe' }], {
      cwd: '/tmp', command, permissionMode: 'never', threadMode: 'persistent', threadName: 'probe',
      runTimeoutMs: 5_000, disposeGraceMs: 100,
    }, new AbortController().signal),
    10_000,
  )
  assert.ok(error instanceof CodexRunFailure, error.stack)
  assert.equal(error.facts.category, 'timeout')
})

test('a hung turn settles as a timeout after publication', async () => {
  const command = fakeServer('hang-turn')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'timeout')
  assert.match(outcome.diagnostic ?? '', /deadline/)
  assert.equal(outcome.cleanup.confirmed, true)
})

test('caller cancellation during startup is aborted, not timed out', async () => {
  const command = fakeServer('hang-initialize')
  const controller = new AbortController()
  const pending = startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 0, disposeGraceMs: 100,
  }, controller.signal)
  setTimeout(() => { controller.abort(new Error('caller stopped it')) }, 50)
  const error = await rejectsWithin(pending, 4_000)
  assert.ok(error instanceof CodexRunFailure, error.stack)
  assert.equal(error.facts.category, 'aborted')
})

test('a process that exits before the thread is started is a process failure', async () => {
  const command = fakeServer('exit-after-init')
  const error = await rejectsWithin(
    startCodexRun([{ type: 'text', text: 'probe' }], {
      cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 5_000, disposeGraceMs: 100,
    }, new AbortController().signal),
    10_000,
  )
  assert.ok(error instanceof CodexRunFailure, error.stack)
  assert.ok(error.facts.category === 'process' || error.facts.category === 'protocol', error.facts.category)
})

test('a stream that ends without a terminal turn is an error, not success', async () => {
  const command = fakeServer('exit-after-turn-start')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.notEqual(outcome.stopReason, 'completed')
  assert.ok(outcome.diagnostic !== undefined)
})

test('a completed turn reports its usage delta and context window', async () => {
  const command = fakeServer('usage')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'completed')
  assert.equal(outcome.usage.status, 'complete')
  assert.equal(outcome.usage.run?.totalTokens, 300)
  assert.equal(outcome.usage.modelContextWindow, 272_000)
})

test('usage observed before a timeout is preserved in the failed outcome', async () => {
  const command = fakeServer('usage-hang')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'timeout')
  assert.equal(outcome.usage.status, 'complete')
  assert.equal(outcome.usage.run?.totalTokens, 300)
})

test('a resumed thread treats its replay as baseline and reports only the increment', async () => {
  const command = fakeServer('usage-resume')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', threadMode: 'persistent', resumeThreadId: 'thread-1',
    runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'completed')
  assert.equal(outcome.usage.replayedBaseline, true)
  assert.equal(outcome.usage.run?.totalTokens, 300)
  assert.equal(outcome.usage.threadTotal?.totalTokens, 1300)
})

test('teardown is idempotent and reports a confirmed process range', async () => {
  const command = fakeServer('complete')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  await run.result
  const first = await run.teardown()
  const second = await run.teardown()
  assert.deepEqual(first, second)
  assert.equal(first.confirmed, true)
})

test('a descendant that ignores SIGTERM is cleaned up with the owned group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pro-descendant-'))
  dirs.push(dir)
  const pidFile = join(dir, 'child.pid')
  const command = fakeServer('descendant')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 5_000, disposeGraceMs: 100,
    env: { FAKE_MODE: 'descendant', FAKE_CHILD_PID_FILE: pidFile },
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'timeout')
  assert.equal(outcome.cleanup.confirmed, true)
  const childPid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(Number.isInteger(childPid) && childPid > 0)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.throws(() => process.kill(childPid, 0), /ESRCH/)
})


test('delegateOnce returns the answer, thread, usage and a confirmed cleanup', async () => {
  const command = fakeServer('complete')
  const seenStarts: string[] = []
  const result = await delegateOnce({
    prompt: 'probe', cwd: '/tmp', command, permissionMode: 'never',
    runTimeoutMs: 5_000, disposeGraceMs: 100, signal: new AbortController().signal,
    onStart: (id) => { seenStarts.push(id) },
  })
  assert.equal(result.text, 'FINAL')
  assert.equal(seenStarts.length, 1)
  assert.equal(result.threadId, 'thread-1')
  assert.equal(result.usage.status, 'unknown')
  assert.equal(result.cleanup.confirmed, true)
  assert.ok(result.configuration !== undefined)
})

test('delegateOnce verifies output_schema and returns the decoded structure', async () => {
  const command = fakeServer('json')
  const result = await delegateOnce({
    prompt: 'probe', cwd: '/tmp', command, permissionMode: 'never',
    runTimeoutMs: 5_000, disposeGraceMs: 100, signal: new AbortController().signal,
    outputSchema: {
      type: 'object', required: ['verdict', 'count'], additionalProperties: false,
      properties: { verdict: { type: 'string' }, count: { type: 'integer' } },
    },
  })
  assert.deepEqual(result.structured, { verdict: 'pass', count: 2 })
  assert.equal(result.text, '{"verdict":"pass","count":2}')
})

test('delegateOnce fails a schema-constrained run whose answer is not valid JSON', async () => {
  const command = fakeServer('bad-json')
  await assert.rejects(
    delegateOnce({
      prompt: 'probe', cwd: '/tmp', command, permissionMode: 'never',
      runTimeoutMs: 5_000, disposeGraceMs: 100, signal: new AbortController().signal,
      outputSchema: { type: 'object', required: ['verdict'] },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CodexDelegationFailure)
      assert.match(error.message, /not valid JSON/)
      assert.ok(error.outcome?.schemaError !== undefined)
      assert.equal(error.outcome?.cleanup.confirmed, true)
      return true
    },
  )
})

test('a failed delegation keeps the usage it observed before the timeout', async () => {
  const command = fakeServer('usage-hang')
  await assert.rejects(
    delegateOnce({
      prompt: 'probe', cwd: '/tmp', command, permissionMode: 'never',
      runTimeoutMs: 5_000, disposeGraceMs: 100, signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CodexDelegationFailure)
      assert.equal(error.outcome?.stopReason, 'timeout')
      assert.equal(error.outcome?.usage.run?.totalTokens, 300)
      assert.equal(error.outcome?.cleanup.confirmed, true)
      return true
    },
  )
})

test('runCodexOnce reports the published id and outcome', async () => {
  const command = fakeServer('complete')
  const ids: string[] = []
  const outcome = await runCodexOnce({
    prompt: 'probe', cwd: '/tmp', command, permissionMode: 'never',
    runTimeoutMs: 5_000, disposeGraceMs: 100, signal: new AbortController().signal,
    onStart: (id) => { ids.push(id) },
  })
  assert.equal(ids.length, 1)
  assert.equal(outcome.stopReason, 'completed')
  assert.equal(outcome.cleanup.confirmed, true)
})

test('textTask and the argv helper reject malformed tasks and name the protocol', () => {
  assert.deepEqual(textTask([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), ['a', 'b'])
  assert.throws(() => textTask([]), /must be text/)
  assert.throws(() => textTask([{ type: 'image' }]), /must be text/)
  assert.throws(() => textTask([{ type: 'text', text: '   ' }]), /must not be empty/)
  assert.deepEqual(codexAppServerArgv('/usr/local/bin/codex'), ['/usr/local/bin/codex', 'app-server', '--stdio'])
})


test('the provider path maps the same outcome without inventing DSH fields', async () => {
  const { CodexExecProvider } = await import('../src/index.ts')
  const command = fakeServer('json')
  const provider = new CodexExecProvider({
    command, providerName: 'codex-pro-test', permissionMode: 'never',
    runTimeoutMs: 5_000,
  })
  const handle = await provider.start({
    prompt: [{ type: 'text', text: 'probe' }],
    parent: { id: 'agent-1', session: { header: { cwd: '/tmp' } }, ctx: {} },
    signal: new AbortController().signal,
    outputSchema: {
      type: 'object', required: ['verdict', 'count'], additionalProperties: false,
      properties: { verdict: { type: 'string' }, count: { type: 'integer' } },
    },
  })
  const result = await handle.result
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.structured, { verdict: 'pass', count: 2 })
  assert.equal('usage' in result, false)
  await handle.dispose()
})

test('the provider path maps a deadline to aborted with the reason in diagnostic', async () => {
  const { CodexExecProvider } = await import('../src/index.ts')
  const command = fakeServer('usage-hang')
  const provider = new CodexExecProvider({
    command, providerName: 'codex-pro-test', permissionMode: 'never',
    runTimeoutMs: 5_000, disposeGraceMs: 100,
  })
  const handle = await provider.start({
    prompt: [{ type: 'text', text: 'probe' }],
    parent: { id: 'agent-1', session: { header: { cwd: '/tmp' } }, ctx: {} },
    signal: new AbortController().signal,
  })
  const result = await handle.result
  assert.equal(result.stopReason, 'aborted')
  assert.match(result.diagnostic ?? '', /deadline/)
  await handle.dispose()
})

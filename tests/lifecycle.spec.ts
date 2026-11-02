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
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
const { writeFileSync, closeSync } = require('node:fs')
const mode = ${JSON.stringify(mode)}
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n')
let buffer = ''
let threadId = 'thread-1'
let turnId = 'turn-1'
let child
let childReady = false
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid))
if (process.env.FAKE_GROUP_PID_FILE) writeFileSync(process.env.FAKE_GROUP_PID_FILE, String(process.ppid))
if (mode === 'descendant' || mode === 'leader-exits-descendant' || mode === 'complete-leader-exits-descendant') {
  child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); if (process.connected) process.send('ready', () => {}); setInterval(() => {}, 1000)"], {
    stdio: mode === 'descendant' ? ['ignore', 'ignore', 'ignore', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'],
  })
  child.on('message', () => { childReady = true })
  if (process.env.FAKE_CHILD_PID_FILE) writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid))
}
process.on('SIGTERM', () => {
  if (process.env.FAKE_TERM_FILE) writeFileSync(process.env.FAKE_TERM_FILE, 'terminating')
})
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
    if (mode === 'flood') { process.stdout.write('x'.repeat(20000)); return }
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
    if (mode === 'usage-resume') {
      notify('thread/tokenUsage/updated', {
        threadId, turnId: 'old-turn',
        tokenUsage: { total: breakdown(1000), last: breakdown(1000), modelContextWindow: 272000 },
      })
    }
    reply(message.id, answerResume(params))
    return
  }
  if (message.method === 'thread/name/set') {
    if (mode === 'hang-name') return
    reply(message.id, {})
    return
  }
  if (message.method === 'turn/start') {
    if (mode === 'usage-late-replay') {
      notify('thread/tokenUsage/updated', {
        threadId, turnId: 'old-turn',
        tokenUsage: { total: breakdown(1000), last: breakdown(1000), modelContextWindow: 272000 },
      })
    }
    reply(message.id, { turn: { id: turnId } })
    if (mode === 'hang-turn-close-stdout') {
      closeSync(1)
      if (process.env.FAKE_STDOUT_CLOSED_FILE) writeFileSync(process.env.FAKE_STDOUT_CLOSED_FILE, 'closed')
      return
    }
    if (mode === 'hang-turn' || mode === 'descendant') return
    if (mode === 'leader-exits-descendant') {
      if (childReady) process.exit(7)
      else child.once('message', () => process.exit(7))
      return
    }
    if (mode === 'complete-leader-exits-descendant') {
      const finish = () => { finishTurn(undefined, 300); setTimeout(() => process.exit(0), 10) }
      if (childReady) finish()
      else child.once('message', finish)
      return
    }
    if (mode === 'usage-hang') {
      notify('thread/tokenUsage/updated', {
        threadId, turnId, tokenUsage: { total: breakdown(300), last: breakdown(300), modelContextWindow: 272000 },
      })
      return
    }
    if (mode === 'exit-after-turn-start') { setImmediate(() => process.exit(0)); return }
    if (mode === 'usage') { setImmediate(() => finishTurn(undefined, 300)); return }
    if (mode === 'usage-resume' || mode === 'usage-late-replay') { setImmediate(() => finishTurn(undefined, 1300)); return }
    if (mode === 'json') { setImmediate(() => finishTurn(undefined, undefined, '{"verdict":"pass","count":2}')); return }
    if (mode === 'bad-json') { setImmediate(() => finishTurn(undefined, undefined, 'not json')); return }
    if (mode === 'complete-exit-code') {
      setImmediate(() => { finishTurn(undefined, undefined); setTimeout(() => process.exit(23), 10) })
      return
    }
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
  assert.equal(error.execution?.timedOut, true)
  assert.equal(error.execution?.cancelled, false)
  assert.equal(error.execution?.turnId, null)
  assert.equal(error.execution?.failure?.category, 'timeout')
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
  assert.equal(outcome.execution.runId, run.id)
  assert.equal(outcome.execution.timedOut, true)
  assert.equal(outcome.execution.cancelled, false)
  assert.equal(outcome.execution.threadId, 'thread-1')
  assert.equal(outcome.execution.turnId, 'turn-1')
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
  assert.equal(error.execution?.cancelled, true)
  assert.equal(error.execution?.timedOut, false)
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
  assert.equal(outcome.execution.runId, run.id)
  assert.ok(outcome.execution.pid !== null)
  assert.ok(outcome.execution.supervisorPid !== null)
  assert.notEqual(outcome.execution.pid, outcome.execution.supervisorPid)
  assert.equal(outcome.execution.truncated, false)
  assert.equal(outcome.execution.failure, null)
  assert.ok(Date.parse(outcome.execution.finishedAt) >= Date.parse(outcome.execution.startedAt))
  assert.ok(outcome.execution.durationMs >= 0)
})

test('usage observed before a timeout is preserved in the failed outcome', async () => {
  const command = fakeServer('usage-hang')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command, permissionMode: 'never', runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'timeout')
  assert.equal(outcome.usage.status, 'partial')
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

test('another turn notification after turn/start cannot invent a complete resume baseline', async () => {
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: fakeServer('usage-late-replay'), permissionMode: 'read-only',
    threadMode: 'persistent', resumeThreadId: 'thread-1', runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'completed')
  assert.equal(outcome.usage.status, 'partial')
  assert.equal(outcome.usage.replayedBaseline, false)
  assert.notEqual(outcome.usage.run?.totalTokens, 300)
  assert.ok(outcome.usage.reason)
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
  assert.match(result.diagnostic ?? '', /timeout/)
  await handle.dispose()
})

test('public cancellation records cancellation independently from timeout', async () => {
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: fakeServer('hang-turn'), permissionMode: 'workspace-write',
    runTimeoutMs: 5_000, disposeGraceMs: 50,
  }, new AbortController().signal)
  run.requestCancel()
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'aborted')
  assert.equal(outcome.execution.cancelled, true)
  assert.equal(outcome.execution.timedOut, false)
  assert.equal(outcome.cleanup.confirmed, true)
})

test('caller cancellation during confirmed-in-progress cleanup cannot become completed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pro-cleanup-cancel-'))
  dirs.push(dir)
  const termFile = join(dir, 'term.marker')
  const controller = new AbortController()
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: fakeServer('usage'), permissionMode: 'read-only',
    runTimeoutMs: 5_000, disposeGraceMs: 1500, env: { FAKE_TERM_FILE: termFile },
  }, controller.signal)
  let settled = false
  run.result.then(() => { settled = true })
  await waitFor(() => { try { return readFileSync(termFile, 'utf8') === 'terminating' } catch { return false } }, 'cleanup signal')
  assert.equal(settled, false, 'the cancellation must happen during cleanup, not after the result')
  controller.abort()
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'aborted')
  assert.equal(outcome.execution.cancelled, true)
  assert.equal(outcome.execution.timedOut, false)
  assert.equal(outcome.usage.status, 'partial')
  assert.equal(outcome.cleanup.confirmed, true)
})

test('output becoming incomplete during cleanup invalidates a completed model turn', async () => {
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: fakeServer('complete-leader-exits-descendant'), permissionMode: 'read-only',
    runTimeoutMs: 5_000, disposeGraceMs: 1800,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.output.map(block => block.text).join(''), 'FINAL')
  assert.equal(outcome.stopReason, 'error')
  assert.equal(outcome.execution.truncated, true)
  assert.equal(outcome.execution.failure?.category, 'output-incomplete')
  assert.equal(outcome.usage.status, 'partial')
  assert.equal(outcome.cleanup.confirmed, true)
})

test('an output limit during unpublished startup is recorded and cleaned up', async () => {
  const error = await rejectsWithin(startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: fakeServer('flood'), permissionMode: 'read-only',
    runTimeoutMs: 5_000, disposeGraceMs: 50, maxOutputBytes: 1024,
  }, new AbortController().signal), 5_000)
  assert.ok(error instanceof CodexRunFailure)
  assert.equal(error.facts.category, 'output-limit')
  assert.equal(error.execution?.truncated, true)
  assert.equal(error.execution?.timedOut, false)
  assert.equal(error.execution?.cancelled, false)
  assert.equal(error.cleanup?.confirmed, true)
})

test('a model final answer cannot hide a real nonzero app-server exit', async () => {
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: fakeServer('complete-exit-code'), permissionMode: 'read-only',
    runTimeoutMs: 5_000, disposeGraceMs: 100,
  }, new AbortController().signal)
  const outcome = await run.result
  assert.equal(outcome.stopReason, 'error')
  assert.equal(outcome.execution.exitCode, 23)
  assert.equal(outcome.execution.signal, null)
  assert.equal(outcome.execution.failure?.category, 'process')
  assert.equal(outcome.cleanup.confirmed, true)
})

test('invalid lifecycle budgets and pre-start cancellation never spawn an app-server', async () => {
  for (const choice of [
    { runTimeoutMs: Number.POSITIVE_INFINITY },
    { runTimeoutMs: 2_147_483_648 },
    { disposeGraceMs: -1 },
    { maxOutputBytes: 0 },
    { maxOutputBytes: 0.5 },
    { deadlineAt: Number.MAX_SAFE_INTEGER },
  ]) {
    await assert.rejects(startCodexRun([{ type: 'text', text: 'probe' }], {
      cwd: '/tmp', command: 'this-command-must-not-be-spawned', permissionMode: 'read-only', ...choice,
    }, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof CodexRunFailure)
      assert.equal(error.facts.category, 'invalid-request')
      assert.equal(error.execution?.pid, null)
      assert.equal(error.execution?.supervisorPid, null)
      assert.equal(error.cleanup?.confirmed, true)
      return true
    })
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: 'this-command-must-not-be-spawned', permissionMode: 'read-only',
  }, controller.signal), (error: unknown) => {
    assert.ok(error instanceof CodexRunFailure)
    assert.equal(error.execution?.cancelled, true)
    assert.equal(error.execution?.pid, null)
    assert.equal(error.execution?.supervisorPid, null)
    return true
  })
})

test('an unconfirmed group cannot complete through the public provider or dispose', async () => {
  const { CodexExecProvider } = await import('../src/index.ts')
  const actualKill = process.kill.bind(process)
  process.kill = ((pid: number, signal?: NodeJS.Signals | number): true => {
    if (pid < 0 && signal === 0) {
      const error = new Error('fixture cannot inspect the owned group') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }
    return actualKill(pid, signal)
  }) as typeof process.kill
  try {
    const provider = new CodexExecProvider({
      command: fakeServer('complete'), providerName: 'codex-pro-test', permissionMode: 'read-only',
      runTimeoutMs: 5_000, disposeGraceMs: 50,
    })
    const handle = await provider.start({
      prompt: [{ type: 'text', text: 'probe' }],
      parent: { id: 'agent-1', session: { header: { cwd: '/tmp' } }, ctx: {} },
      signal: new AbortController().signal,
    })
    const outcome = await handle.result
    assert.equal(outcome.stopReason, 'error')
    assert.match(outcome.diagnostic ?? '', /cleanup/)
    await assert.rejects(handle.dispose(), /cleanup/)
  } finally {
    process.kill = actualKill
  }
})

/** Poll only a fixture-owned record/process, with an outer test deadline. */
async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8'))
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch { return undefined }
}

function groupGone(pid: number): boolean {
  try { process.kill(-pid, 0); return false } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

for (const mode of ['hang-initialize', 'descendant'] as const) {
  test(`a killed caller cannot orphan its ${mode} app-server group`, { skip: process.platform === 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pro-parent-kill-'))
    dirs.push(dir)
    const pidFile = join(dir, 'codex.pid')
    const groupFile = join(dir, 'group.pid')
    const childPidFile = join(dir, 'descendant.pid')
    const command = fakeServer(mode)
    const spec = {
      cwd: '/tmp', command, permissionMode: 'workspace-write', runTimeoutMs: 0, disposeGraceMs: 100,
      env: { FAKE_PID_FILE: pidFile, FAKE_GROUP_PID_FILE: groupFile, FAKE_CHILD_PID_FILE: childPidFile },
    }
    const script = `import { startCodexRun } from ${JSON.stringify(new URL('../src/run.ts', import.meta.url).href)};
      const run = await startCodexRun([{type:'text',text:'probe'}], ${JSON.stringify(spec)}, new AbortController().signal);
      await run.result;`
    const caller = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    })
    assert.ok(caller.pid !== undefined)
    pids.push(caller.pid)
    let stderr = ''
    caller.stderr.on('data', chunk => { stderr += String(chunk) })
    const callerClosed = new Promise<void>(resolve => caller.once('close', () => resolve()))
    await waitFor(() => readPid(groupFile) !== undefined && readPid(pidFile) !== undefined
      && (mode !== 'descendant' || readPid(childPidFile) !== undefined), `fixture startup ${stderr}`)
    const groupPid = readPid(groupFile)!
    pids.push(groupPid)
    caller.kill('SIGKILL')
    await callerClosed
    await waitFor(() => groupGone(groupPid), 'guardian cleanup after parent SIGKILL')
    assert.throws(() => process.kill(readPid(pidFile)!, 0), /ESRCH/)
    if (mode === 'descendant') assert.throws(() => process.kill(readPid(childPidFile)!, 0), /ESRCH/)
  })
}

test('caller death before guardian module startup is detected by the inherited IPC lease', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pro-early-parent-kill-'))
  dirs.push(dir)
  const groupFile = join(dir, 'group.pid')
  const preload = join(dir, 'delay-guardian.mjs')
  writeFileSync(preload, `import {writeFileSync} from 'node:fs';
    if (/process-guardian\\.(ts|js)$/.test(process.argv[1] || '')) {
      writeFileSync(${JSON.stringify(groupFile)}, String(process.pid));
      await new Promise(resolve => setTimeout(resolve, 500));
    }`)
  const spec = {
    cwd: '/tmp', command: fakeServer('hang-initialize'), permissionMode: 'read-only',
    runTimeoutMs: 0, disposeGraceMs: 100,
    env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
  }
  const script = `import {startCodexRun} from ${JSON.stringify(new URL('../src/run.ts', import.meta.url).href)};
    await startCodexRun([{type:'text',text:'probe'}], ${JSON.stringify(spec)}, new AbortController().signal);`
  const caller = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'ignore', detached: true,
  })
  assert.ok(caller.pid !== undefined)
  pids.push(caller.pid)
  const closed = new Promise<void>(resolve => caller.once('close', () => resolve()))
  await waitFor(() => readPid(groupFile) !== undefined, 'guardian preloader')
  const groupPid = readPid(groupFile)!
  pids.push(groupPid)
  caller.kill('SIGKILL')
  await closed
  await waitFor(() => groupGone(groupPid), 'pre-start orphan cleanup')
})

test('a dead leader cannot keep timeout=0 pending through a descendant holding stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pro-leader-exit-'))
  dirs.push(dir)
  const childPidFile = join(dir, 'descendant.pid')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: fakeServer('leader-exits-descendant'), permissionMode: 'read-only',
    runTimeoutMs: 0, disposeGraceMs: 100, env: { FAKE_CHILD_PID_FILE: childPidFile },
  }, new AbortController().signal)
  let timer: NodeJS.Timeout | undefined
  const outcome = await Promise.race([
    run.result,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        run.requestCancel()
        reject(new Error('leader-exit drain did not settle within its independent deadline'))
      }, 5_000)
      timer.unref()
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
  assert.notEqual(outcome.stopReason, 'completed')
  assert.equal(outcome.execution.exitCode, 7)
  assert.equal(outcome.execution.timedOut, false)
  assert.equal(outcome.execution.truncated, true)
  assert.equal(outcome.cleanup.confirmed, true)
  assert.throws(() => process.kill(readPid(childPidFile)!, 0), /ESRCH/)
})

for (const mode of ['hang-turn', 'hang-turn-close-stdout'] as const) {
test(`a killed guardian cannot leave timeout=0 waiting on its still-live Codex pipes (${mode})`, {
  skip: process.platform === 'win32',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pro-guardian-exit-'))
  dirs.push(dir)
  const groupFile = join(dir, 'group.pid')
  const appServerFile = join(dir, 'codex.pid')
  const stdoutClosedFile = join(dir, 'stdout.closed')
  const run = await startCodexRun([{ type: 'text', text: 'probe' }], {
    cwd: '/tmp', command: fakeServer(mode), permissionMode: 'read-only',
    runTimeoutMs: 0, disposeGraceMs: 100,
    env: { FAKE_GROUP_PID_FILE: groupFile, FAKE_PID_FILE: appServerFile, FAKE_STDOUT_CLOSED_FILE: stdoutClosedFile },
  }, new AbortController().signal)
  const guardianPid = readPid(groupFile)
  const appServerPid = readPid(appServerFile)
  assert.ok(guardianPid !== undefined && appServerPid !== undefined)
  pids.push(guardianPid)
  assert.equal(process.kill(appServerPid, 0), true)
  if (mode === 'hang-turn-close-stdout') {
    await waitFor(() => { try { return readFileSync(stdoutClosedFile, 'utf8') === 'closed' } catch { return false } }, 'Codex stdout closure')
  }
  // Deliberately kill only the guardian, not its already-owned process group.
  process.kill(guardianPid, 'SIGKILL')
  let timer: NodeJS.Timeout | undefined
  const outcome = await Promise.race([
    run.result,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        run.requestCancel()
        reject(new Error('guardian-exit drain did not settle within its independent deadline'))
      }, 5_000)
      timer.unref()
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
  assert.equal(outcome.stopReason, 'error')
  assert.equal(outcome.execution.supervisorSignal, 'SIGKILL')
  assert.equal(outcome.execution.exitCode, null)
  assert.equal(outcome.execution.signal, null)
  assert.equal(outcome.execution.timedOut, false)
  assert.equal(outcome.execution.failure?.stage, 'supervisor')
  assert.equal(outcome.cleanup.confirmed, true)
  assert.equal(groupGone(guardianPid), true)
  assert.throws(() => process.kill(appServerPid, 0), /ESRCH/)
})
}

test('signal denial returns a failed receipt and releases the caller while the guardian cleans up', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-pro-signal-denial-'))
  dirs.push(dir)
  const groupFile = join(dir, 'group.pid')
  const appServerFile = join(dir, 'codex.pid')
  const spec = {
    cwd: '/tmp', command: fakeServer('usage'), permissionMode: 'read-only',
    runTimeoutMs: 5_000, disposeGraceMs: 100,
    env: { FAKE_GROUP_PID_FILE: groupFile, FAKE_PID_FILE: appServerFile },
  }
  const script = `import {startCodexRun} from ${JSON.stringify(new URL('../src/run.ts', import.meta.url).href)};
    const actualKill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      if (pid < 0 && signal !== 0) { const e = new Error('injected signal denial'); e.code='EPERM'; throw e; }
      return actualKill(pid, signal);
    };
    const run = await startCodexRun([{type:'text',text:'probe'}], ${JSON.stringify(spec)}, new AbortController().signal);
    const result = await run.result;
    process.stdout.write(JSON.stringify(result) + String.fromCharCode(10));
    // No process.exit: this must naturally exit after releasing local handles.
  `
  const caller = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  assert.ok(caller.pid !== undefined)
  pids.push(caller.pid)
  let stdout = ''
  let stderr = ''
  caller.stdout.on('data', chunk => { stdout += String(chunk) })
  caller.stderr.on('data', chunk => { stderr += String(chunk) })
  let timer: NodeJS.Timeout | undefined
  const closed = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
    caller.once('error', reject)
    caller.once('close', (code, signal) => resolve({ code, signal }))
    timer = setTimeout(() => {
      caller.kill('SIGKILL')
      reject(new Error('signal-denial caller kept its own event loop alive after reporting failure'))
    }, 8_000)
  }).finally(() => { if (timer !== undefined) clearTimeout(timer) })
  await waitFor(() => readPid(groupFile) !== undefined && readPid(appServerFile) !== undefined, 'denied-signal fixture startup')
  const groupPid = readPid(groupFile)!
  pids.push(groupPid)
  const status = await closed
  assert.deepEqual(status, { code: 0, signal: null }, stderr)
  const outcome = JSON.parse(stdout)
  assert.equal(outcome.stopReason, 'error')
  assert.equal(outcome.cleanup.confirmed, false)
  assert.match(outcome.cleanup.detail, /injected signal denial/)
  assert.equal(outcome.usage.status, 'partial')
  await waitFor(() => groupGone(groupPid), 'guardian cleanup after releasing a failed lease')
  assert.throws(() => process.kill(readPid(appServerFile)!, 0), /ESRCH/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMachine, recoverMachine, type MachineLifecycleEvent, type MachineRequest } from '../src/machine.ts'
import { CodexRunFailure, startCodexRun } from '../src/run.ts'

function fixture(t: { after(fn: () => void): void }) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'codex-name-admission-')))
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const command = join(cwd, 'server.mjs'), capture = join(cwd, 'calls.jsonl'), recoveryDirectory = join(cwd, 'journal')
  copyFileSync(new URL('./fixtures/thread-name-admission-server.mjs', import.meta.url), command)
  chmodSync(command, 0o755)
  const request: MachineRequest = { protocol: 1, requestId: 'name-admission', cwd, command,
    prompt: 'PRIVATE_TASK_PROMPT', model: 'fixture-model', effort: 'high', permissionMode: 'workspace-write',
    threadMode: 'persistent', timeoutMs: 10_000 }
  const messages = (): { method: string; params: Record<string, unknown> }[] => existsSync(capture)
    ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  return { request, recoveryDirectory, messages, env: { CODEX_NAME_ADMISSION_CAPTURE: capture } }
}

for (const explicit of [true, false]) {
  test(`${explicit ? 'explicit' : 'fallback'} machine name rejection prevents dispatch and retains recoverable cleanup and identity`, async t => {
    const f = fixture(t), lifecycle: MachineLifecycleEvent[] = []
    const request = { ...f.request, ...(explicit ? { threadName: 'Flywheel · design · Alert latency' } : {}) }
    const result = await runMachine(request, { recoveryDirectory: f.recoveryDirectory,
      env: { ...f.env, CODEX_NAME_ADMISSION_MODE: 'reject' }, onLifecycle: event => { lifecycle.push(event) } })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.outcome, null)
    assert.equal(result.failure?.stage, 'thread-name')
    assert.equal(result.failure?.category, 'protocol')
    assert.match(result.failure?.diagnostic ?? '', /required.*thread name.*not confirmed/i)
    assert.doesNotMatch(result.failure?.diagnostic ?? '', /PRIVATE_NATIVE|PRIVATE_TASK/)
    assert.equal(result.failure?.execution?.threadId, 'name-admission-thread')
    assert.equal(result.failure?.execution?.turnId, null)
    assert.equal(result.failure?.execution?.dispatch, 'not-dispatched')
    assert.equal(result.failure?.execution?.cancelled, false)
    assert.equal(result.failure?.execution?.timedOut, false)
    assert.equal(result.failure?.cleanup?.confirmed, true)
    assert.deepEqual(lifecycle.map(event => event.event), ['terminal', 'cleanup-confirmed'])
    assert.ok(lifecycle.every(event => event.threadId === 'name-admission-thread'
      && event.dispatch === 'not-dispatched' && event.outcome === 'failed' && event.cleanupConfirmed))
    const calls = f.messages()
    assert.equal(calls.filter(call => call.method === 'thread/name/set').length, 1)
    assert.equal(calls.some(call => call.method === 'turn/start'), false)
    if (explicit) assert.equal(calls.find(call => call.method === 'thread/name/set')?.params.name, request.threadName)
    else assert.match(String(calls.find(call => call.method === 'thread/name/set')?.params.name), /^DSH · codex-name-admission-/)
    const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId,
      runId: result.runId, recoveryDirectory: f.recoveryDirectory })
    assert.equal(recovered.status, 'terminal')
    assert.deepEqual(recovered.receipt, result)
    assert.deepEqual(f.messages(), calls, 'read-only recovery cannot retry a naming or model request')
    if (process.platform !== 'win32') {
      const group = result.failure?.execution?.supervisorPid
      assert.ok(group)
      assert.throws(() => process.kill(-group!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH')
    }
  })
}

test('accepted machine name precedes thread-ready and the only prompt dispatch', async t => {
  const f = fixture(t)
  const result = await runMachine({ ...f.request, threadName: 'Flywheel · review · Alert latency' }, {
    env: f.env, onLifecycle: event => {
      if (event.event !== 'thread-ready') return
      assert.equal(f.messages().filter(call => call.method === 'thread/name/set').length, 1)
      assert.equal(f.messages().some(call => call.method === 'turn/start'), false)
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome?.output[0]?.text, 'NAMING_ADMISSION_OK')
  assert.equal(f.messages().filter(call => call.method === 'turn/start').length, 1)
})

for (const mode of ['resume', 'ephemeral'] as const) {
  test(`${mode} does not require or attempt a name write`, async t => {
    const f = fixture(t)
    const result = await runMachine({ ...f.request, threadName: 'Do not rename an existing session',
      ...(mode === 'resume' ? { threadId: 'human-named-history' } : { threadMode: 'ephemeral' as const }) },
    { env: { ...f.env, CODEX_NAME_ADMISSION_MODE: 'reject' } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(f.messages().some(call => call.method === 'thread/name/set'), false)
    assert.equal(f.messages().filter(call => call.method === 'turn/start').length, 1)
    if (mode === 'resume') assert.equal(result.outcome?.threadId, 'human-named-history')
    else assert.equal(f.messages().find(call => call.method === 'thread/start')?.params.ephemeral, true)
  })
}

test('cancelling a pending required name retains cancellation and never dispatches the task', async t => {
  const f = fixture(t), controller = new AbortController()
  const pending = runMachine({ ...f.request, threadName: 'Pending title' }, {
    env: { ...f.env, CODEX_NAME_ADMISSION_MODE: 'hang' }, signal: controller.signal,
  })
  t.after(() => controller.abort())
  const deadline = Date.now() + 10_000
  while (!f.messages().some(call => call.method === 'thread/name/set')) {
    assert.ok(Date.now() < deadline, 'the real name request should reach the peer')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.failure?.stage, 'thread-name')
  assert.equal(result.failure?.category, 'aborted')
  assert.equal(result.failure?.execution?.cancelled, true)
  assert.equal(result.failure?.execution?.timedOut, false)
  assert.equal(result.failure?.execution?.dispatch, 'not-dispatched')
  assert.equal(result.failure?.cleanup?.confirmed, true)
  assert.equal(f.messages().some(call => call.method === 'turn/start'), false)
})

test('direct legacy runs retain best-effort naming without machine admission requirements', async t => {
  const f = fixture(t)
  const run = await startCodexRun([{ type: 'text', text: f.request.prompt }], {
    cwd: f.request.cwd, command: f.request.command!, model: f.request.model,
    effort: f.request.effort, permissionMode: 'workspace-write', threadMode: 'persistent',
    threadName: 'Legacy best-effort title', runTimeoutMs: 10_000,
    env: { ...f.env, CODEX_NAME_ADMISSION_MODE: 'reject' },
  }, new AbortController().signal)
  const result = await run.result
  assert.equal(result.stopReason, 'completed', JSON.stringify(result))
  assert.equal(result.cleanup.confirmed, true)
  assert.equal(f.messages().filter(call => call.method === 'turn/start').length, 1)
})

test('a direct required name uses the fallback even without an explicit title', async t => {
  const f = fixture(t)
  await assert.rejects(startCodexRun([{ type: 'text', text: f.request.prompt }], {
    cwd: f.request.cwd, command: f.request.command!, model: f.request.model,
    effort: f.request.effort, permissionMode: 'workspace-write', threadMode: 'persistent',
    requireThreadName: true, runTimeoutMs: 10_000,
    env: { ...f.env, CODEX_NAME_ADMISSION_MODE: 'reject' },
  }, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof CodexRunFailure)
    assert.deepEqual(error.facts, { stage: 'thread-name', category: 'protocol' })
    assert.equal(error.execution?.dispatch, 'not-dispatched')
    assert.equal(error.execution?.threadId, 'name-admission-thread')
    assert.equal(error.cleanup?.confirmed, true)
    return true
  })
  assert.match(String(f.messages().find(call => call.method === 'thread/name/set')?.params.name),
    /^DSH · codex-name-admission-/)
  assert.equal(f.messages().some(call => call.method === 'turn/start'), false)
})

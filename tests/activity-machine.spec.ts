import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMachine, recoverMachine, type ActivityEvent, type MachineLifecycleEvent } from '../src/machine.ts'

function fixture(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-activity-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const command = join(cwd, 'server.mjs')
  copyFileSync(new URL('./fixtures/machine-server.mjs', import.meta.url), command)
  chmodSync(command, 0o755)
  return { protocol: 1 as const, requestId: 'activity', cwd, command, prompt: 'private prompt',
    model: 'fixture-model', effort: 'high', permissionMode: 'workspace-write' as const, timeoutMs: 10_000 }
}

for (const child of [false, true]) test(`public supervised machine forwards actual ${child ? 'child-only' : 'root'} reasoning activity`, async t => {
  const request = fixture(t), events: ActivityEvent[] = [], lifecycle: MachineLifecycleEvent[] = []
  const recoveryDirectory = join(request.cwd, 'journal')
  const result = await runMachine({ ...request, ...(child ? { native: { version: 1 as const, agents: { enabled: true } } } : {}) }, {
    env: { FAKE_MACHINE_MODE: child ? 'activity-child' : 'activity-root' }, activityIntervalMs: 30,
    recoveryDirectory, onLifecycle: event => { lifecycle.push(event) }, onActivity: event => { events.push(event) },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(events.filter(e => e.eventTypes.includes('item/reasoning/summaryTextDelta')).length >= 3)
  assert.ok(events.some(e => e.scope === (child ? 'child' : 'root') || e.scope === 'mixed'))
  assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING'), false)
  assert.equal(JSON.stringify(events).includes('private prompt'), false)
  assert.equal(JSON.stringify(events).includes('threadId'), false)
  assert.ok(events.every((e, i) => e.sequence === i + 1 && e.observedEvents > 0))
  assert.ok(lifecycle.some(e => e.event === 'cleanup-confirmed'))
  const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: result.runId, recoveryDirectory })
  assert.equal(recovered.receipt?.ok, true, 'activity is independent of durable terminal recovery')
})

test('default native tools report child-only activity without inventing a requested native policy', async t => {
  const request = fixture(t), events: ActivityEvent[] = [], capture = join(request.cwd, 'default-native.jsonl')
  const argvFile = join(request.cwd, 'argv.json')
  const nativeEvents: unknown[] = []
  const result = await runMachine(request, {
    env: { FAKE_MACHINE_MODE: 'activity-child', FAKE_MACHINE_CAPTURE: capture, FAKE_MACHINE_ARGV_FILE: argvFile }, activityIntervalMs: 30,
    onLifecycle: () => {}, onNativeEvent: event => { nativeEvents.push(event) }, onActivity: event => { events.push(event) },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(events.filter(e => e.eventTypes.includes('item/reasoning/summaryTextDelta') && ['child', 'mixed'].includes(e.scope)).length >= 3)
  assert.equal(result.native, undefined, 'observed ownership must not invent a requested native receipt')
  assert.deepEqual(nativeEvents, [], 'native evidence remains opt-in, separate from activity')
  const requests = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(requests.some(r => r.method === 'config/read'), false)
  assert.equal(requests.find(r => r.method === 'thread/start').params.config, undefined)
  assert.deepEqual(JSON.parse(readFileSync(argvFile, 'utf8')), ['app-server', '--stdio'])
})

test('more than 32 MiB of valid deltas do not exhaust an 8 KiB retained-output allowance', async t => {
  const request = fixture(t), events: ActivityEvent[] = []
  const result = await runMachine({ ...request, maxOutputBytes: 8192 }, {
    env: { FAKE_MACHINE_MODE: 'activity-burst' }, activityIntervalMs: 50,
    onLifecycle: () => {}, onActivity: event => { events.push(event) },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome?.execution.truncated, false)
  assert.equal(result.outcome?.output[0]?.text, 'ACTIVITY_OK')
  assert.ok(events.length < 200, 'observations are coalesced, never one IPC frame per token')
  assert.ok(Buffer.byteLength(JSON.stringify(events)) < 64 * 1024)
})

test('retained image bodies remain bounded even when every individual frame fits', async t => {
  const request = fixture(t)
  const result = await runMachine({ ...request, maxOutputBytes: 4096 }, { env: { FAKE_MACHINE_MODE: 'retained-images' } })
  assert.equal(result.ok, false)
  assert.equal(result.outcome?.execution.truncated, true)
  assert.equal(result.outcome?.cleanup.confirmed, true)
  assert.equal(result.outcome?.execution.failure?.category, 'output-limit')
})

test('activity and naming inputs fail before process startup when invalid', async t => {
  const request = fixture(t)
  for (const activityIntervalMs of [0, -1, 0.5, 60_001, Infinity]) {
    await assert.rejects(runMachine(request, { activityIntervalMs }), /activityIntervalMs/)
  }
  await assert.rejects(runMachine(request, { onActivity: 'not-a-function' } as never), /onActivity/)
  for (const threadName of ['', 'multi\nline', 'x'.repeat(1025)]) {
    await assert.rejects(runMachine({ ...request, threadName }), /threadName/)
  }
})

for (const mode of ['activity-unowned', 'activity-stale-root', 'activity-child-stale']) test(`${mode} cannot produce activity for this invocation`, async t => {
  const request = fixture(t), events: ActivityEvent[] = []
  const result = await runMachine({ ...request, native: { version: 1, agents: { enabled: true } } }, {
    env: { FAKE_MACHINE_MODE: mode }, activityIntervalMs: 1,
    onLifecycle: () => {}, onActivity: event => { events.push(event) },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(events.some(e => e.eventTypes.includes('item/reasoning/summaryTextDelta')), false)
})

test('a truly quiet provider receives no manufactured activity and still times out with cleanup', async t => {
  const request = fixture(t), events: ActivityEvent[] = []
  const result = await runMachine({ ...request, timeoutMs: 500 }, {
    env: { FAKE_MACHINE_MODE: 'activity-quiet' }, activityIntervalMs: 10,
    onLifecycle: () => {}, onActivity: event => { events.push(event) },
  })
  assert.equal(result.ok, false)
  assert.equal(result.outcome?.execution.timedOut, true)
  assert.equal(result.outcome?.cleanup.confirmed, true)
  assert.equal(events.length, 1, 'only the observed turn/started may appear before the timeout')
  assert.deepEqual(events[0]?.eventTypes, ['turn/started'])
})

test('new persistent threads get readable names while resumed and ephemeral threads are never renamed', async t => {
  const request = fixture(t), capture = join(request.cwd, 'capture.jsonl')
  const options = { env: { FAKE_MACHINE_CAPTURE: capture } }
  const fresh = await runMachine({ ...request, threadMode: 'persistent', threadName: 'Flywheel · alerts · Design' }, options)
  assert.equal(fresh.ok, true)
  const initial = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(initial.filter(x => x.method === 'thread/name/set').map(x => x.params.name), ['Flywheel · alerts · Design'])
  const resumed = await runMachine({ ...request, threadMode: 'persistent', threadId: fresh.outcome!.threadId,
    threadName: 'Do not replace a human title' }, options)
  assert.equal(resumed.ok, true)
  const ephemeral = await runMachine({ ...request, threadMode: 'ephemeral', threadName: 'No persistence change' }, options)
  assert.equal(ephemeral.ok, true)
  const all = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(all.filter(x => x.method === 'thread/name/set').length, 1)
  const fallback = await runMachine({ ...request, threadMode: 'persistent' }, options)
  assert.equal(fallback.ok, true)
  const names = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.method === 'thread/name/set')
  assert.match(names.at(-1).params.name, /^DSH · codex-activity-/)
  assert.equal(names.at(-1).params.name.includes(request.prompt), false)
})

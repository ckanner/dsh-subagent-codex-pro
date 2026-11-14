import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMachine, parseMachineRequest, type NativeEvent } from '../src/machine.ts'
import { NativeTracker, nativeArguments, parseNativeRequest } from '../src/native.ts'

function fixture(t: { after(fn: () => void): void }) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-')))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const command = join(cwd, 'codex.mjs')
  copyFileSync(fileURLToPath(new URL('./fixtures/machine-server.mjs', import.meta.url)), command)
  chmodSync(command, 0o755)
  return { protocol: 1 as const, requestId: 'native-1', cwd, command, prompt: 'fixture',
    model: 'test-model', effort: 'high', permissionMode: 'workspace-write', timeoutMs: 5000 }
}
const total = (n: number) => ({ totalTokens: n, inputTokens: n - 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 })

test('native policy validates before dispatch and off disables both Codex backends', t => {
  const input = fixture(t)
  assert.equal(parseMachineRequest(Object.freeze({ ...input, native: { version: 1, agents: { enabled: false } } })).native?.agents?.enabled, false)
  for (const native of [{ version: 2 }, { version: 1, agents: { enabled: true, maxConcurrentThreads: 0 } },
    { version: 1, agents: { enabled: false, defaultModel: 'x' } }, { version: 1, review: { target: { type: 'invented' } } }]) {
    assert.throws(() => parseMachineRequest({ ...input, native }))
  }
  assert.throws(() => parseMachineRequest({ ...input, threadId: 'executor', threadMode: 'persistent', native: { version: 1, review: { target: { type: 'uncommittedChanges' } } } }), /fresh/)
  assert.deepEqual(nativeArguments({ version: 1, agents: { enabled: false } }), ['-c', 'agents.enabled=false', '-c', 'features.multi_agent_v2=false'])
  assert.match(nativeArguments({ version: 1, agents: { enabled: true, backend: 'v2', maxConcurrentThreads: 3 } }).join(' '), /max_concurrent_threads_per_session = 4/)
})

test('native configuration mismatch rejects before thread and model dispatch', async t => {
  const input = fixture(t), capture = join(input.cwd, 'capture')
  const receipt = await runMachine({ ...input, native: { version: 1, agents: { enabled: false } } }, { env: { FAKE_MACHINE_MODE: 'native-mismatch', FAKE_MACHINE_CAPTURE: capture } })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.native?.effective.matched, false)
  assert.equal(receipt.native?.cleanup.confirmed, true)
  const messages = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(messages.some(m => ['thread/start', 'turn/start', 'review/start'].includes(m.method)), false)
})

test('native children retain ownership, early events and deduplicated usage through supervised receipt', async t => {
  const input = fixture(t), events: NativeEvent[] = []
  const receipt = await runMachine({ ...input, native: { version: 1, agents: { enabled: true, maxConcurrentThreads: 2 } } }, {
    env: { FAKE_MACHINE_MODE: 'native-child' }, recoveryDirectory: join(input.cwd, 'journal'),
    onNativeEvent: e => { events.push(e) }, onLifecycle: async () => {},
  })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.outcome?.usage.run?.totalTokens, 140)
  assert.equal(receipt.native?.usage.totalTokens, 50)
  assert.equal(receipt.native?.usage.scope, 'observed-children')
  assert.equal(receipt.native?.children[0]?.parentId, 'machine-thread')
  assert.equal(receipt.native?.children[0]?.state, 'completed')
  assert.equal(receipt.native?.children[0]?.model, 'child-model')
  assert.equal(receipt.native?.cleanup.confirmed, true)
  assert.equal(new Set(events.map(e => e.sequence)).size, events.length)
  assert.ok(events.some(e => e.id === 'child-1'))
})

test('resume observations never attribute historical child totals to this invocation', () => {
  const tracker = new NativeTracker(parseNativeRequest({ version: 1, agents: { enabled: true } }))
  tracker.setRoot('root')
  tracker.observe('thread/started', { thread: { id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } } } })
  tracker.observe('thread/tokenUsage/updated', { threadId: 'child', turnId: 'old', tokenUsage: { total: total(1000) } })
  tracker.observe('turn/started', { threadId: 'child', turn: { id: 'new' } })
  for (const n of [1020, 1040, 1040]) tracker.observe('thread/tokenUsage/updated', { threadId: 'child', turnId: 'new', tokenUsage: { total: total(n) } })
  assert.equal(tracker.report().usage.children.child?.run?.totalTokens, 40)
  assert.equal(tracker.report().usage.totalTokens, null)
  tracker.observe('turn/started', { threadId: 'child', turn: { id: 'second' } })
  tracker.observe('thread/tokenUsage/updated', { threadId: 'child', turnId: 'second', tokenUsage: { total: total(1060) } })
  assert.equal(tracker.report().usage.children.child?.run?.totalTokens, 60)
  tracker.observe('turn/completed', { threadId: 'child', turn: { id: 'second', status: 'completed' } })
  assert.equal(tracker.report().usage.totalTokens, 60)
  tracker.observe('thread/tokenUsage/updated', { threadId: 'stranger', turnId: 'bad', tokenUsage: { total: total(10000) } })
  assert.equal(tracker.report().children.length, 1)
})

test('child thread ancestry received before the root response survives bounded orphan replay', () => {
  const tracker = new NativeTracker(parseNativeRequest({ version: 1, agents: { enabled: true } }))
  tracker.observe('thread/started', { thread: { id: 'grandchild', source: { subAgent: { thread_spawn: { parent_thread_id: 'child' } } } } })
  tracker.observe('thread/started', { thread: { id: 'child', source: { subAgent: { thread_spawn: { parent_thread_id: 'root' } } } } })
  tracker.observe('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
  tracker.observe('turn/started', { threadId: 'grandchild', turn: { id: 'grandchild-turn' } })
  tracker.observe('thread/started', { thread: { id: 'stranger', parentThreadId: 'foreign' } })
  assert.equal(tracker.owns('child'), false)
  tracker.setRoot('root')
  assert.equal(tracker.owns('child'), true)
  assert.equal(tracker.owns('grandchild'), true)
  assert.equal(tracker.owns('stranger'), false)
  assert.equal(tracker.acceptsTurn('child', 'child-turn'), true)
  assert.equal(tracker.acceptsTurn('grandchild', 'grandchild-turn'), true)
  assert.equal(tracker.report().children.length, 2)
})

test('unfinished native child snapshots remain partial after physical cleanup', () => {
  const tracker = new NativeTracker(parseNativeRequest({ version: 1, agents: { enabled: true } }))
  tracker.setRoot('root')
  tracker.observe('item/completed', { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'] } })
  tracker.observe('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
  tracker.observe('thread/tokenUsage/updated', { threadId: 'child', turnId: 'child-turn', tokenUsage: { total: total(50) } })
  const interrupted = tracker.report(true)
  assert.equal(interrupted.cleanup.confirmed, true)
  assert.equal(interrupted.completion.confirmed, false)
  assert.equal(interrupted.children[0]?.usage?.status, 'partial')
  assert.equal(interrupted.usage.children.child?.status, 'partial')
  assert.equal(interrupted.usage.children.child?.run?.totalTokens, 50)
  assert.equal(interrupted.usage.status, 'partial')
  assert.equal(interrupted.usage.totalTokens, null)
  tracker.observe('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } })
  assert.equal(tracker.report().usage.status, 'complete')
  assert.equal(tracker.report().usage.totalTokens, 50)
})

test('native child started before the root response retains approval ownership through real transport', async t => {
  const input = fixture(t), capture = join(input.cwd, 'capture')
  const receipt = await runMachine({ ...input, native: { version: 1, agents: { enabled: true } } }, {
    env: { FAKE_MACHINE_MODE: 'native-child-early-root', FAKE_MACHINE_CAPTURE: capture },
  })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.native?.children.length, 1)
  assert.equal(receipt.native?.children[0]?.parentId, 'machine-thread')
  assert.equal(receipt.native?.children[0]?.state, 'completed')
  assert.equal(receipt.native?.children[0]?.model, 'child-model')
  const messages = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(messages.find(m => m.id === 701)?.result?.decision, 'decline')
})

test('native review uses a fresh verified thread and the dedicated review endpoint', async t => {
  const input = fixture(t), capture = join(input.cwd, 'capture')
  const receipt = await runMachine({ ...input, native: { version: 1, review: { target: { type: 'baseBranch', branch: 'main' } } } }, { env: { FAKE_MACHINE_CAPTURE: capture } })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.outcome?.output[0]?.text, 'NATIVE_REVIEW_OK')
  const messages = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(messages.some(m => m.method === 'turn/start'), false)
  assert.deepEqual(messages.find(m => m.method === 'review/start').params, { threadId: 'machine-thread', delivery: 'inline', target: { type: 'baseBranch', branch: 'main' } })
  assert.equal(receipt.native?.effective.config?.review_model, input.model)
  assert.equal(receipt.native?.effective.config?.model_reasoning_effort, 'high')
})

test('native cancellation interrupts known child turns and confirms owned process cleanup', async t => {
  const input = fixture(t), capture = join(input.cwd, 'capture'), controller = new AbortController()
  const receipt = await runMachine({ ...input, native: { version: 1, agents: { enabled: true } } }, {
    signal: controller.signal, env: { FAKE_MACHINE_MODE: 'native-child-hang', FAKE_MACHINE_CAPTURE: capture },
    onNativeEvent: e => { if (e.kind === 'child-turn-started') setTimeout(() => controller.abort(), 10) },
  })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.native?.cleanup.confirmed, true)
  const messages = readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(messages.some(m => m.method === 'turn/interrupt' && m.params.threadId === 'child-1'))
})

test('late child turn events cannot replace the current turn or make it terminal', () => {
  const tracker = new NativeTracker(parseNativeRequest({ version: 1, agents: { enabled: true } }))
  tracker.setRoot('root')
  tracker.observe('thread/started', { thread: { id: 'child', parentThreadId: 'root' } })
  for (const id of ['z-opaque-old', 'a-opaque-new']) tracker.observe('turn/started', { threadId: 'child', turn: { id } })
  tracker.observe('turn/completed', { threadId: 'child', turn: { id: 'z-opaque-old', status: 'completed' } })
  tracker.observe('turn/started', { threadId: 'child', turn: { id: 'z-opaque-old' } })
  assert.deepEqual(tracker.running(), [{ threadId: 'child', turnId: 'a-opaque-new' }])
  assert.equal(tracker.acceptsTurn('child', 'z-opaque-old'), false)
  assert.equal(tracker.report().completion.confirmed, false)
  tracker.observe('turn/completed', { threadId: 'child', turn: { id: 'a-opaque-new', status: 'failed' } })
  assert.equal(tracker.report().completion.confirmed, true)
  tracker.observe('turn/started', { threadId: 'child', turn: { id: 'a-opaque-new' } })
  assert.equal(tracker.report().children[0]?.state, 'failed')
})

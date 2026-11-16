import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMachine, recoverMachine, type ActivityEvent, type NativeEvent } from '../src/machine.ts'
import { NativeTracker, type NativeRequest } from '../src/native.ts'

const native = { version: 1 as const, agents: { enabled: true } }
type Tracker = NativeTracker<NativeRequest | undefined>
const total = (n: number) => ({ totalTokens: n, inputTokens: n - 10, cachedInputTokens: 0,
  outputTokens: 10, reasoningOutputTokens: 0 })

function childTurn(tracker: Tracker, method: 'turn/started' | 'turn/completed', id = 'first-turn', status = 'completed') {
  tracker.observe(method, { threadId: 'child', turn: { id, status } })
}
function parentSnapshot(tracker: Tracker, status: string, tool = 'spawnAgent', type = 'collabAgentToolCall') {
  tracker.observe('item/completed', { threadId: 'root', turnId: 'root-turn', item: {
    type, tool, senderThreadId: 'root', receiverThreadIds: ['child'], model: 'child-model',
    agentsStates: { child: { status } },
  } })
}

for (const type of ['collabAgentToolCall', 'collaborationToolCall']) {
  for (const status of ['completed', 'failed', 'interrupted']) {
    test(`late ${type} creation snapshot preserves observed ${status} child turn`, () => {
      const tracker = new NativeTracker(native)
      tracker.setRoot('root')
      childTurn(tracker, 'turn/started')
      tracker.observe('thread/tokenUsage/updated', { threadId: 'child', turnId: 'first-turn', tokenUsage: { total: total(50) } })
      childTurn(tracker, 'turn/completed', 'first-turn', status)
      parentSnapshot(tracker, 'running', 'spawnAgent', type)

      const receipt = tracker.report(true)
      assert.equal(receipt.children[0]?.state, status)
      assert.equal(receipt.children[0]?.model, 'child-model', 'a late snapshot still supplies metadata')
      assert.equal(receipt.children[0]?.turnId, 'first-turn')
      assert.equal(receipt.completion.confirmed, true)
      assert.equal(receipt.usage.totalTokens, 50, 'creation evidence still makes orphan usage attributable')
      assert.deepEqual(tracker.running(), [])
      assert.equal(tracker.activeTurn('child', 'first-turn'), false)
    })
  }
}

for (const type of ['collabAgentToolCall', 'collaborationToolCall']) {
  for (const status of ['completed', 'failed', 'closed', 'shutdown', 'errored', 'interrupted', 'notFound']) {
    test(`duplicate ${type} creation cannot replace parent-only ${status} evidence`, () => {
      const tracker = new NativeTracker(native)
      tracker.setRoot('root')
      parentSnapshot(tracker, status, 'spawnAgent', type)
      assert.equal(tracker.report().children[0]?.turnId, null)
      assert.equal(tracker.report().completion.confirmed, true)
      for (const stale of ['running', 'completed']) {
        parentSnapshot(tracker, stale, 'spawnAgent', type)
        assert.equal(tracker.report().children[0]?.state, status)
        assert.equal(tracker.report().completion.confirmed, true)
      }
      childTurn(tracker, 'turn/started', 'actual-new-turn')
      assert.equal(tracker.activeTurn('child', 'actual-new-turn'), true)
      assert.equal(tracker.report().completion.confirmed, false, 'real new work is not frozen')
      childTurn(tracker, 'turn/completed', 'actual-new-turn')
      assert.equal(tracker.report().completion.confirmed, true)
    })
  }
}

for (const tool of ['sendInput', 'followupTask']) {
  test(`late creation cannot finish ${tool} work queued without a child turn identity`, () => {
    const tracker = new NativeTracker(native)
    tracker.setRoot('root')
    parentSnapshot(tracker, 'completed')
    parentSnapshot(tracker, 'running', tool)
    assert.equal(tracker.report().children[0]?.turnId, null)
    parentSnapshot(tracker, 'completed')
    assert.equal(tracker.report().children[0]?.state, 'running')
    assert.equal(tracker.report().completion.confirmed, false)
    childTurn(tracker, 'turn/started', 'actual-new-turn')
    childTurn(tracker, 'turn/completed', 'actual-new-turn')
    assert.equal(tracker.report().completion.confirmed, true)
  })
}

test('creation snapshots may advance an initial pending child to completion', () => {
  const tracker = new NativeTracker(native)
  tracker.setRoot('root')
  for (const status of ['pendingInit', 'running', 'completed']) {
    parentSnapshot(tracker, status)
    assert.equal(tracker.report().children[0]?.state, status)
    assert.equal(tracker.report().completion.confirmed, status === 'completed')
  }
})

test('v2 creation cannot replace parent-only terminal or subsequent interaction evidence', () => {
  const tracker = new NativeTracker(native)
  tracker.setRoot('root')
  const activity = (kind: string) => tracker.observe('item/completed', {
    threadId: 'root', turnId: 'root-turn', item: {
      type: 'subAgentActivity', id: 'spawn-child', agentThreadId: 'child', kind,
    },
  })
  activity('completed')
  activity('started')
  assert.equal(tracker.report().children[0]?.turnId, null)
  assert.equal(tracker.report().children[0]?.state, 'completed')
  assert.equal(tracker.report().completion.confirmed, true)
  activity('interacted')
  activity('started')
  assert.equal(tracker.report().children[0]?.state, 'interacted')
  assert.equal(tracker.report().completion.confirmed, false)
  childTurn(tracker, 'turn/started', 'actual-new-turn')
  childTurn(tracker, 'turn/completed', 'actual-new-turn')
  assert.equal(tracker.report().completion.confirmed, true)
})

test('late terminal creation snapshot cannot finish an actual new child turn', () => {
  const tracker = new NativeTracker(native)
  tracker.setRoot('root')
  childTurn(tracker, 'turn/started')
  childTurn(tracker, 'turn/completed')
  childTurn(tracker, 'turn/started', 'second-turn')
  parentSnapshot(tracker, 'completed')
  assert.equal(tracker.report().completion.confirmed, false)
  assert.deepEqual(tracker.running(), [{ threadId: 'child', turnId: 'second-turn' }])
  childTurn(tracker, 'turn/completed', 'first-turn')
  assert.equal(tracker.activeTurn('child', 'second-turn'), true)
  childTurn(tracker, 'turn/completed', 'second-turn')
  assert.equal(tracker.report().completion.confirmed, true)
})

test('a creation snapshot remains useful until a child lifecycle is observed', () => {
  for (const status of ['running', 'completed']) {
    const tracker = new NativeTracker(native)
    tracker.setRoot('root')
    parentSnapshot(tracker, status)
    assert.equal(tracker.report().children[0]?.state, status)
    assert.equal(tracker.report().completion.confirmed, status === 'completed')
  }
})

test('late creation cannot reopen an observed closed child with no turn identity', () => {
  const tracker = new NativeTracker(native)
  tracker.setRoot('root')
  tracker.observe('thread/started', { thread: { id: 'child', parentThreadId: 'root' } })
  tracker.observe('thread/closed', { threadId: 'child' })
  parentSnapshot(tracker, 'running')
  assert.equal(tracker.report().children[0]?.state, 'closed')
  assert.equal(tracker.report().completion.confirmed, true)
  childTurn(tracker, 'turn/started', 'actual-restart')
  assert.equal(tracker.activeTurn('child', 'actual-restart'), true)
})

for (const tool of ['sendInput', 'followupTask']) {
  test(`${tool} still marks queued work pending before its actual turn starts`, () => {
    const tracker = new NativeTracker(native)
    tracker.setRoot('root')
    parentSnapshot(tracker, 'running')
    childTurn(tracker, 'turn/started')
    childTurn(tracker, 'turn/completed')
    assert.equal(tracker.report().completion.confirmed, true)
    parentSnapshot(tracker, 'running', tool)
    assert.equal(tracker.report().completion.confirmed, false, 'creation precedence must not suppress later dispatch evidence')
    childTurn(tracker, 'turn/started', 'second-turn')
    assert.equal(tracker.activeTurn('child', 'second-turn'), true)
    childTurn(tracker, 'turn/completed', 'second-turn')
    assert.equal(tracker.report().completion.confirmed, true)
  })
}

test('default native ownership uses the same creation precedence without requesting a receipt', () => {
  const tracker = new NativeTracker(undefined)
  tracker.setRoot('root')
  childTurn(tracker, 'turn/started')
  childTurn(tracker, 'turn/completed')
  parentSnapshot(tracker, 'running')
  assert.equal(tracker.owns('child'), true)
  assert.equal(tracker.activeTurn('child', 'first-turn'), false)
  assert.deepEqual(tracker.running(), [])
  childTurn(tracker, 'turn/started', 'second-turn')
  parentSnapshot(tracker, 'completed')
  assert.equal(tracker.activeTurn('child', 'second-turn'), true)
})

test('v2 started creation marker cannot revive a completed or closed child', () => {
  const started = { threadId: 'root', turnId: 'root-turn', item: {
    type: 'subAgentActivity', id: 'spawn-child', agentThreadId: 'child', kind: 'started', model: 'v2-child-model',
  } }
  for (const closed of [false, true]) {
    const tracker = new NativeTracker(native)
    tracker.setRoot('root')
    if (closed) {
      tracker.observe('thread/started', { thread: { id: 'child', parentThreadId: 'root' } })
      tracker.observe('thread/closed', { threadId: 'child' })
    } else {
      childTurn(tracker, 'turn/started')
      childTurn(tracker, 'turn/completed')
    }
    tracker.observe('item/completed', started)
    assert.equal(tracker.report().children[0]?.state, closed ? 'closed' : 'completed')
    assert.equal(tracker.report().children[0]?.model, 'v2-child-model')
    assert.equal(tracker.report().completion.confirmed, true)
    childTurn(tracker, 'turn/started', 'second-turn')
    tracker.observe('item/completed', started)
    assert.equal(tracker.activeTurn('child', 'second-turn'), true)
    childTurn(tracker, 'turn/completed', 'second-turn')
    assert.equal(tracker.report().completion.confirmed, true)
  }
  const tracker = new NativeTracker(native)
  tracker.setRoot('root')
  tracker.observe('item/completed', started)
  assert.equal(tracker.report().children[0]?.state, 'running', 'creation remains fallback without a child lifecycle')
})

function fixture(t: { after(fn: () => void): void }) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-snapshot-')))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const command = join(cwd, 'server.mjs')
  copyFileSync(new URL('./fixtures/native-snapshot-order-server.mjs', import.meta.url), command)
  chmodSync(command, 0o755)
  return { protocol: 1 as const, requestId: 'native-snapshot', cwd, command, prompt: 'fixture',
    model: 'test-model', effort: 'high', permissionMode: 'workspace-write' as const, timeoutMs: 10_000 }
}

for (const mode of ['parent-first', 'child-first', 'v2-child-first', 'next-pending', 'next-completed']) {
  test(`public supervised machine preserves creation ordering: ${mode}`, async t => {
    const input = fixture(t), events: NativeEvent[] = [], activity: ActivityEvent[] = []
    const recoveryDirectory = join(input.cwd, 'journal')
    const receipt = await runMachine({ ...input, native: mode.startsWith('v2-')
      ? { version: 1, agents: { enabled: true, backend: 'v2' } } : native }, {
      env: { NATIVE_SNAPSHOT_ORDER: mode }, recoveryDirectory, activityIntervalMs: 1,
      onNativeEvent: event => { events.push(event) }, onActivity: event => { activity.push(event) },
    })
    const complete = mode !== 'next-pending'
    assert.equal(receipt.ok, complete, JSON.stringify(receipt))
    assert.equal(receipt.outcome?.output[0]?.text, 'PARENT_DONE')
    assert.equal(receipt.native?.completion.confirmed, complete)
    assert.equal(receipt.native?.cleanup.confirmed, true)
    assert.deepEqual(receipt.native?.completion.pendingIds, complete ? [] : ['child'])
    assert.equal(receipt.native?.children[0]?.turnId, mode.startsWith('next-') ? 'second-turn' : 'first-turn')
    assert.equal(receipt.native?.children[0]?.state, complete ? 'completed' : 'running')
    assert.equal(receipt.native?.usage.totalTokens, complete ? (mode === 'next-completed' ? 70 : 50) : null)
    assert.equal(activity.some(event => event.eventTypes.includes('item/reasoning/summaryTextDelta')), false,
      'late creation must not restore activity ownership for a finished turn')
    if (mode.endsWith('child-first')) {
      const completed = events.findIndex(event => event.kind === 'child-turn-completed')
      assert.ok(completed >= 0)
      assert.equal(events.slice(completed + 1).some(event => event.state === 'running'), false)
    }
    if (!complete) assert.equal(receipt.outcome?.execution.failure?.category, 'completion')
    const recovered = await recoverMachine({ protocol: 1, requestId: input.requestId, runId: receipt.runId, recoveryDirectory })
    assert.equal(recovered.receipt?.ok, complete)
    assert.deepEqual(recovered.receipt?.native?.completion, receipt.native?.completion)
  })
}

for (const mode of ['parent-only', 'v2-parent-only', 'parent-only-queued', 'parent-only-next-completed']) {
  test(`public supervised machine preserves parent-only creation evidence: ${mode}`, async t => {
    const input = fixture(t), recoveryDirectory = join(input.cwd, 'journal')
    const receipt = await runMachine({ ...input, native: mode.startsWith('v2-')
      ? { version: 1, agents: { enabled: true, backend: 'v2' } } : native }, {
      env: { NATIVE_SNAPSHOT_ORDER: mode }, recoveryDirectory,
    })
    const complete = mode !== 'parent-only-queued'
    assert.equal(receipt.ok, complete, JSON.stringify(receipt))
    assert.equal(receipt.outcome?.output[0]?.text, 'PARENT_DONE')
    assert.equal(receipt.native?.completion.confirmed, complete)
    assert.equal(receipt.native?.cleanup.confirmed, true)
    assert.deepEqual(receipt.native?.completion.pendingIds, complete ? [] : ['child'])
    assert.equal(receipt.native?.children[0]?.turnId, mode === 'parent-only-next-completed' ? 'second-turn' : null)
    assert.equal(receipt.native?.children[0]?.state, complete ? 'completed' : 'running')
    assert.equal(receipt.native?.usage.totalTokens, mode === 'parent-only-next-completed' ? 70 : null,
      'terminal creation evidence cannot invent unobserved token usage')
    if (!complete) assert.equal(receipt.outcome?.execution.failure?.category, 'completion')
    const recovered = await recoverMachine({ protocol: 1, requestId: input.requestId, runId: receipt.runId, recoveryDirectory })
    assert.equal(recovered.receipt?.ok, complete)
    assert.deepEqual(recovered.receipt?.native?.children, receipt.native?.children)
    assert.deepEqual(recovered.receipt?.native?.completion, receipt.native?.completion)
  })
}

test('public default native ownership rejects activity from a child finished before its creation snapshot', async t => {
  const input = fixture(t), activity: ActivityEvent[] = []
  const receipt = await runMachine(input, { env: { NATIVE_SNAPSHOT_ORDER: 'child-first' }, activityIntervalMs: 1,
    onActivity: event => { activity.push(event) } })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.native, undefined)
  assert.equal(activity.some(event => event.eventTypes.includes('item/reasoning/summaryTextDelta')), false)
})

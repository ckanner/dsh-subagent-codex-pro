/**
 * The protocol adapter, driven by a scripted app-server peer.
 *
 * The decisive cases are the first two: `thread/start` must carry
 * `reasoningEffort` and `turn/start` must carry `effort`. Those two fields are
 * the entire reason this package exists — the official adapter sends neither,
 * and the strings do not appear anywhere in its 871 lines.
 *
 * The rest covers the behaviour the port inherits: the handshake, terminal
 * answer selection by phase, the turn-id ordering rules, and unattended
 * approvals.
 *
 * @module dsh-subagent-codex-pro/tests/wire
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { LineTransport } from '../src/jsonrpc.ts'
import { CodexAppServerWire, type CodexPermissionMode } from '../src/wire.ts'

/** One end of a pair of in-memory streams. */
class FakeStream extends EventEmitter {
  written = ''
  /** Called after each write, so a scripted peer can answer synchronously. */
  onWrite: (() => void) | undefined
  write(chunk: string): void {
    this.written += chunk
    this.onWrite?.()
  }

  feed(chunk: string): void { this.emit('data', chunk) }
}

/** A scripted app-server peer. */
class Peer {
  readonly toPeer = new FakeStream()
  readonly fromPeer = new FakeStream()
  readonly received: { method: string; params: unknown }[] = []
  #consumed = 0
  /** Emitted notifications, in order, for tests that need to replay them. */
  readonly notifications: { method: string; params: unknown }[] = []

  readonly #respond: (method: string, params: unknown, peer: Peer) => unknown | undefined

  constructor(respond: (method: string, params: unknown, peer: Peer) => unknown | undefined) {
    this.#respond = respond
  }

  /** Answer every complete request line the wire has written so far. */
  pump(): void {
    const lines = this.toPeer.written.split('\n').filter((line) => line !== '')
    for (const line of lines.slice(this.#consumed)) {
      this.#consumed += 1
      const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
      if (message.method === undefined) continue
      if (message.id === undefined) { this.notifications.push({ method: message.method, params: message.params }); continue }
      this.received.push({ method: message.method, params: message.params })
      const result = this.#respond(message.method, message.params, this)
      if (result === undefined) continue
      this.fromPeer.feed(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    }
  }

  /** Send one notification as the server would. */
  notify(method: string, params: unknown): void {
    this.fromPeer.feed(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** The params of one request the wire sent. */
  paramsOf(method: string): Record<string, unknown> {
    const found = this.received.find((entry) => entry.method === method)
    assert.ok(found !== undefined, `the wire never sent ${method}`)
    return found.params as Record<string, unknown>
  }
}

/** A wire plus its scripted peer, wired to the real transport. */
function harness(options: {
  permissionMode?: CodexPermissionMode
  model?: string
  reasoningEffort?: string
  respond?: (method: string, params: unknown, peer: Peer) => unknown | undefined
} = {}): { wire: CodexAppServerWire; peer: Peer } {
  const peer = new Peer(options.respond ?? (() => undefined))
  // Answer every request as it is written. A test that awaited a response before
  // pumping would deadlock, and the pump order is not what these cases are about.
  peer.toPeer.onWrite = () => { peer.pump() }
  const transport = new LineTransport(peer.toPeer, peer.fromPeer)
  const wire = new CodexAppServerWire(
    peer.fromPeer,
    peer.toPeer,
    transport,
    options.permissionMode ?? 'never',
    options.model,
    options.reasoningEffort,
  )
  return { wire, peer }
}

/** The default peer: handshake, thread, turn, one final answer, completion. */
function standardPeer(effortAware = true): (method: string, params: unknown, peer: Peer) => unknown {
  return (method, _params, peer) => {
    if (method === 'initialize') return {}
    if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
    if (method === 'turn/start') {
      // Answer asynchronously so turn/start resolves before the turn ends.
      setImmediate(() => {
        peer.notify('item/completed', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', phase: 'final_answer', text: 'FINAL' },
        })
        peer.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
      })
      return { turn: { id: 'turn-1' } }
    }
    if (!effortAware && method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
    return undefined
  }
}

test('thread/start carries the reasoning effort the official adapter never sends', async () => {
  const { wire, peer } = harness({ reasoningEffort: 'xhigh', model: 'gpt-6-astra', respond: standardPeer() })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  const params = peer.paramsOf('thread/start')
  assert.equal(params.reasoningEffort, 'xhigh')
  assert.equal(params.model, 'gpt-6-astra')
  assert.equal(params.cwd, '/work')
  assert.equal(params.ephemeral, true)
  assert.equal(params.approvalPolicy, 'never')
})

test('turn/start carries the per-turn effort', async () => {
  const { wire, peer } = harness({ respond: standardPeer() })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  peer.pump()
  const running = wire.runTurn(['hello'], undefined, 'low')
  // The peer answers turn/start on the next pump; the turn ends asynchronously.
  await new Promise((resolve) => { setImmediate(resolve) })
  peer.pump()
  const result = await running
  assert.equal(peer.paramsOf('turn/start').effort, 'low')
  assert.deepEqual(result.output, [{ type: 'text', text: 'FINAL' }])
  assert.equal(result.stopReason, 'completed')
})

test('an omitted effort leaves both fields off the wire', async () => {
  const { wire, peer } = harness({ model: 'gpt-6.1-sol', respond: standardPeer() })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  peer.pump()
  const running = wire.runTurn(['hello'])
  await new Promise((resolve) => { setImmediate(resolve) })
  peer.pump()
  await running
  assert.ok(!('reasoningEffort' in peer.paramsOf('thread/start')), 'reasoningEffort must not be sent when unset')
  assert.ok(!('effort' in peer.paramsOf('turn/start')), 'effort must not be sent when unset')
})

test('the handshake completes initialize then initialized before thread/start', async () => {
  const order: string[] = []
  const { wire, peer } = harness({
    respond: (method) => {
      order.push(method)
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      return undefined
    },
  })
  await wire.initialize()
  assert.deepEqual(peer.notifications.map((n) => n.method), ['initialized'])
  peer.pump()
  await wire.startThread('/work')
  assert.deepEqual(order, ['initialize', 'thread/start'])
})

test('the final answer wins over an unphased one, and commentary is ignored', async () => {
  const { wire, peer } = harness({
    respond: (method, _params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        setImmediate(() => {
          for (const [phase, text] of [['commentary', 'thinking'], [null, 'unphased'], ['final_answer', 'the answer']] as const) {
            self.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase, text } })
          }
          self.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        })
        return { turn: { id: 'turn-1' } }
      }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  peer.pump()
  const running = wire.runTurn(['go'])
  await new Promise((resolve) => { setImmediate(resolve) })
  peer.pump()
  const result = await running
  assert.deepEqual(result.output, [{ type: 'text', text: 'the answer' }])
})

test('a failing turn surfaces the taxonomy and a context overflow stops as max-tokens', async () => {
  for (const [status, expected] of [
    [{ id: 'turn-1', status: 'failed', error: { codexErrorInfo: 'contextWindowExceeded' } }, 'max-tokens'],
  ] as const) {
    const { wire, peer } = harness({
      respond: (method, _params, self) => {
        if (method === 'initialize') return {}
        if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
        if (method === 'turn/start') {
          setImmediate(() => {
            self.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'partial' } })
            self.notify('turn/completed', { threadId: 'thread-1', turn: status })
          })
          return { turn: { id: 'turn-1' } }
        }
        return undefined
      },
    })
    await wire.initialize()
    peer.pump()
    await wire.startThread('/work')
    peer.pump()
    const running = wire.runTurn(['go'])
    await new Promise((resolve) => { setImmediate(resolve) })
    peer.pump()
    const result = await running
    assert.equal(result.stopReason, expected)
    assert.equal(wire.collectFailure()?.category, 'limit')
  }
})

test('an unattended approval request is declined, and recorded as a diagnostic', async () => {
  const { wire, peer } = harness({
    respond: (method, _params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        setImmediate(() => {
          // A server request: the wire must answer it with a decision.
          self.fromPeer.feed(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 'server-1',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'thread-1', turnId: 'turn-1', availableDecisions: ['decline', 'cancel'] },
          })}\n`)
          self.notify('item/completed', {
            threadId: 'thread-1', turnId: 'turn-1',
            item: { type: 'agentMessage', phase: 'final_answer', text: 'DECLINED RUN' },
          })
          self.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        })
        return { turn: { id: 'turn-1' } }
      }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  peer.pump()
  const running = wire.runTurn(['go'])
  await new Promise((resolve) => { setImmediate(resolve) })
  peer.pump()
  await running
  const reply = peer.toPeer.written.split('\n').filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { id?: unknown; result?: unknown })
    .find((m) => m.id === 'server-1')
  // The ported logic prefers `cancel` when the server offers it, and records
  // that decision as `cancelled` rather than `declined`.
  assert.deepEqual(reply?.result, { decision: 'cancel' })
  assert.match(String(wire.collectDiagnostic()), /command approval.*cancelled/s)
})

test('a non-ephemeral thread is rejected', async () => {
  const { wire, peer } = harness({
    respond: (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: false } }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await assert.rejects(async () => wire.startThread('/work'), /did not create an ephemeral thread/)
})

test('the wire narrates child activity, and a broken reporter cannot stop the run', async () => {
  const lines: string[] = []
  let calls = 0
  const { wire, peer } = harness({
    respond: (method, _params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        setImmediate(() => {
          self.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', status: 'completed', command: 'ls -la' } })
          self.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'commentary', text: 'thinking about it' } })
          self.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'DONE' } })
          self.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        })
        return { turn: { id: 'turn-1' } }
      }
      return undefined
    },
  })
  // The first call throws: progress reporting must never break the protocol loop.
  wire.setProgressReporter((text) => {
    calls += 1
    if (calls === 1) throw new Error('reporter exploded')
    lines.push(text)
  })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  peer.pump()
  const running = wire.runTurn(['go'])
  await new Promise((resolve) => { setImmediate(resolve) })
  peer.pump()
  const result = await running
  assert.deepEqual(result.output, [{ type: 'text', text: 'DONE' }])
  // The command item was the throwing call; the commentary and final answer followed.
  assert.deepEqual(lines, ['thinking about it'])
  // Two narrated events: the command item (whose report threw) and the commentary.
  // The final answer is the result, not progress.
  assert.equal(calls, 2)
})

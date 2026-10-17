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
/**
 * A responder returns this to answer with a JSON-RPC error rather than a result.
 *
 * Without it the double can only ever reply successfully, which leaves every
 * failure branch untestable.
 */
const FAIL = Symbol('scripted JSON-RPC failure')

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
      if (result === FAIL) {
        this.fromPeer.feed(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'scripted failure' } })}\n`)
        continue
      }
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
  threadMode?: 'ephemeral' | 'persistent'
  originator?: string
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
    {
      permissionMode: options.permissionMode ?? 'never',
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      threadMode: options.threadMode,
      originator: options.originator,
    },
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
          for (const [phase, text] of [['commentary', 'thinking'], [null, 'unphased'], ['partial_answer', 'partial'], ['final_answer', 'the answer']] as const) {
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

test('a partial answer is the fallback when no final answer arrives', async () => {
  // Codex emits `partial_answer` for stable answer text that later assistant
  // output or tool calls may follow. DSH 0.2.1's official adapter selects
  // final -> partial -> unphased; a run with only a partial answer must not fail.
  const { wire, peer } = harness({
    respond: (method, _params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        setImmediate(() => {
          for (const [phase, text] of [['commentary', 'thinking'], [null, 'unphased'], ['partial_answer', 'stable answer']] as const) {
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
  assert.deepEqual(result.output, [{ type: 'text', text: 'stable answer' }])
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
  await assert.rejects(
    async () => wire.startThread('/work'),
    /created a persistent thread where ephemeral was asked for/,
  )
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
  // The thread line startThread now reports is the throwing call; the command
  // item, whose report succeeded, and the commentary follow it.
  assert.deepEqual(lines, ['commandExecution completed: ls -la', 'thinking about it'])
  // Three narrated events: the thread, the command item, and the commentary. The
  // final answer is the result, not progress.
  assert.equal(calls, 3)
})

test('persistent mode asks for a durable thread and reports its id', async () => {
  const { wire, peer } = harness({
    threadMode: 'persistent',
    respond: (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-9', ephemeral: false } }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  assert.equal(peer.paramsOf('thread/start').ephemeral, false)
  assert.equal(wire.threadId, 'thread-9')
})

test('persistent mode is rejected when the app-server downgrades it', async () => {
  const { wire, peer } = harness({
    threadMode: 'persistent',
    respond: (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await assert.rejects(
    async () => wire.startThread('/work'),
    /created a ephemeral thread where persistent was asked for/,
  )
})

test('resumeThread continues a thread without restating model or effort', async () => {
  const { wire, peer } = harness({
    model: 'gpt-6-astra',
    reasoningEffort: 'xhigh',
    respond: (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') return { thread: { id: 'thread-7', ephemeral: false } }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.resumeThread('thread-7')
  const params = peer.paramsOf('thread/resume')
  assert.equal(params.threadId, 'thread-7')
  // Both are thread/start parameters: a resumed thread keeps the ones it was made with.
  assert.equal(params.model, undefined)
  assert.equal(params.reasoningEffort, undefined)
  assert.equal(wire.threadId, 'thread-7')
})

test('resumeThread refuses a reply about another thread', async () => {
  const { wire, peer } = harness({
    respond: (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') return { thread: { id: 'someone-else' } }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await assert.rejects(async () => wire.resumeThread('thread-7'), /answered for someone-else, not thread-7/)
})

test('the originator reaches initialize, and defaults to Codex Desktop', async () => {
  const named = harness({ originator: 'dsh-plugin-lcu', respond: (m) => (m === 'initialize' ? {} : undefined) })
  await named.wire.initialize()
  named.peer.pump()
  assert.equal((named.peer.paramsOf('initialize').clientInfo as { name: string }).name, 'dsh-plugin-lcu')

  const byDefault = harness({ respond: (m) => (m === 'initialize' ? {} : undefined) })
  await byDefault.wire.initialize()
  byDefault.peer.pump()
  assert.equal((byDefault.peer.paramsOf('initialize').clientInfo as { name: string }).name, 'Codex Desktop')
})

test('a persistent thread can be named, and naming never fails the run', async () => {
  const { wire, peer } = harness({
    threadMode: 'persistent',
    respond: (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-5', ephemeral: false } }
      if (method === 'thread/name/set') return {}
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')

  // Before a thread exists there is nothing to name.
  const empty = harness({ respond: (m) => (m === 'initialize' ? {} : undefined) })
  await empty.wire.initialize()
  empty.peer.pump()
  assert.equal(await empty.wire.setThreadName('too early'), false)

  assert.equal(await wire.setThreadName('DSH · probe'), true)
  const params = peer.paramsOf('thread/name/set')
  assert.equal(params.threadId, 'thread-5')
  assert.equal(params.name, 'DSH · probe')
})

test('naming failure is reported, not thrown', async () => {
  const { wire, peer } = harness({
    threadMode: 'persistent',
    respond: (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-6', ephemeral: false } }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  // The peer answers thread/name/set with a JSON-RPC error, which the wire
  // reports as a false rather than letting it fail the run.
  const failing = harness({
    threadMode: 'persistent',
    respond: (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-7', ephemeral: false } }
      if (method === 'thread/name/set') return FAIL
      return undefined
    },
  })
  await failing.wire.initialize()
  failing.peer.pump()
  await failing.wire.startThread('/work')
  assert.equal(await failing.wire.setThreadName('anything'), false)
})

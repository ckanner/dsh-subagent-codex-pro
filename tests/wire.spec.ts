/**
 * The protocol adapter, driven by a scripted app-server peer.
 *
 * The decisive cases are the per-call model and per-turn `effort`, the 0.165
 * resume overrides, and the effective-configuration checks. A thinking level is
 * a `turn/start` field, not a `thread/start` field in 0.165/0.166.
 *
 * The rest covers the behaviour the port inherits: the handshake, terminal
 * answer selection by phase, the turn-id ordering rules, unattended approvals,
 * and token-usage notification accounting.
 *
 * @module dsh-subagent-codex-pro/tests/wire
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
      threadMode: options.threadMode,
      originator: options.originator,
    },
  )
  return { wire, peer }
}

/** A complete 0.165/0.166 thread reply for ordinary successful fixture runs. */
function threadResponse(params: unknown, id = 'thread-1', ephemeral = true): Record<string, unknown> {
  const requested = params as Record<string, unknown>
  const sandbox = requested.sandbox ?? 'workspace-write'
  const type = sandbox === 'read-only' ? 'readOnly'
    : sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess'
  return {
    thread: { id, ephemeral }, model: requested.model ?? 'server-default',
    cwd: requested.cwd ?? '/work', approvalPolicy: requested.approvalPolicy ?? 'never',
    approvalsReviewer: requested.approvalsReviewer ?? 'user', sandbox: { type }, reasoningEffort: 'low',
  }
}

/** The default peer: handshake, thread, turn, one final answer, completion. */
function standardPeer(effortAware = true): (method: string, params: unknown, peer: Peer) => unknown {
  return (method, params, peer) => {
    if (method === 'initialize') return {}
    if (method === 'thread/start') return threadResponse(params)
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
    if (!effortAware && method === 'thread/start') return threadResponse(params)
    return undefined
  }
}

test('thread/start sends protocol parameters and no invention of reasoningEffort', async () => {
  const { wire, peer } = harness({ model: 'gpt-6-astra', respond: standardPeer() })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  const params = peer.paramsOf('thread/start')
  // 0.165/0.166 ThreadStartParams has no reasoningEffort; thinking is per turn.
  assert.equal(params.reasoningEffort, undefined)
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
    respond: (method, params) => {
      order.push(method)
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params)
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
    respond: (method, params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params)
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
    respond: (method, params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params)
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
      respond: (method, params, self) => {
        if (method === 'initialize') return {}
        if (method === 'thread/start') return threadResponse(params)
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
    respond: (method, params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params)
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
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params, 'thread-1', false)
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
    respond: (method, params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params)
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
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params, 'thread-9', false)
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
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params)
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

test('resumeThread continues a thread without restating unset values', async () => {
  const { wire, peer } = harness({
    respond: (method, params) => {
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
  assert.equal(params.model, undefined)
  assert.equal(params.cwd, undefined)
  assert.equal(wire.threadId, 'thread-7')
})

test('resumeThread applies explicit model, cwd and permission overrides', async () => {
  const { wire, peer } = harness({
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') {
        const requested = params as Record<string, unknown>
        return {
          thread: { id: 'thread-7', ephemeral: false },
          model: requested.model,
          cwd: requested.cwd,
          approvalPolicy: requested.approvalPolicy,
          approvalsReviewer: requested.approvalsReviewer,
          sandbox: { type: 'readOnly' },
        }
      }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.resumeThread('thread-7', { model: 'gpt-6.1-terra', cwd: '/work', permission: 'read-only' })
  const params = peer.paramsOf('thread/resume')
  assert.equal(params.model, 'gpt-6.1-terra')
  assert.equal(params.cwd, '/work')
  assert.equal(params.approvalPolicy, 'never')
  assert.equal(params.sandbox, 'read-only')
  assert.equal(wire.configuration?.requested.model, 'gpt-6.1-terra')
  assert.equal(wire.configuration?.effective.model, 'gpt-6.1-terra')
  assert.equal(wire.configuration?.matched, true)
})

test('resumeThread fails when the app-server ignored a requested override', async () => {
  const { wire } = harness({
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') {
        return {
          thread: { id: 'thread-7', ephemeral: false },
          model: 'gpt-5.6-sol',
          cwd: '/somewhere-else',
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly' },
        }
      }
      return undefined
    },
  })
  await wire.initialize()
  await assert.rejects(
    wire.resumeThread('thread-7', { model: 'gpt-6.1-terra', cwd: '/work', permission: 'read-only' }),
    /did not apply the requested configuration/,
  )
})

test('read-only permission is never confused with approvalPolicy=never alone', async () => {
  const { wire, peer } = harness({ permissionMode: 'read-only', respond: standardPeer() })
  await wire.initialize()
  peer.pump()
  await wire.startThread('/work')
  const params = peer.paramsOf('thread/start')
  assert.equal(params.approvalPolicy, 'never')
  assert.equal(params.sandbox, 'read-only')
})

for (const method of ['thread/start', 'thread/resume'] as const) {
  for (const field of ['model', 'cwd', 'approvalPolicy', 'sandbox'] as const) {
    for (const malformed of [false, true]) {
      test(`${method} rejects ${malformed ? 'malformed' : 'missing'} effective ${field} before a turn`, async () => {
        const { wire, peer } = harness({
          model: 'gpt-required', permissionMode: 'read-only',
          respond: (name, params) => {
            if (name === 'initialize') return {}
            if (name === method) {
              const reply = threadResponse(params, 'thread-1', method === 'thread/start')
              if (malformed) reply[field] = field === 'sandbox' ? { type: 'unknownPolicy' } : 42
              else delete reply[field]
              return reply
            }
            return undefined
          },
        })
        await wire.initialize()
        const startup = method === 'thread/start'
          ? wire.startThread('/work')
          : wire.resumeThread('thread-1', { model: 'gpt-required', cwd: '/work', permission: 'read-only' })
        await assert.rejects(startup, /missing or invalid/)
        assert.equal(wire.configuration?.source, method)
        assert.equal(wire.configuration?.matched, false)
        assert.deepEqual(wire.configuration?.missing, [field])
        assert.equal(wire.configuration?.effective[field], undefined)
        await assert.rejects(wire.runTurn(['must not send']), /verified thread configuration/)
        assert.equal(peer.received.some(request => request.method === 'turn/start'), false)
        wire.close()
      })
    }
  }
}

test('requested reviewer cannot be silently absent from an auto-review configuration', async () => {
  const { wire } = harness({
    permissionMode: 'approve-for-me',
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method !== 'thread/start') return undefined
      const reply = threadResponse(params)
      delete reply.approvalsReviewer
      return reply
    },
  })
  await wire.initialize()
  await assert.rejects(wire.startThread('/work'), /missing or invalid approvalsReviewer/)
  assert.deepEqual(wire.configuration?.missing, ['approvalsReviewer'])
  wire.close()
})

test('workspace-write sends never and an explicit sandbox and preserves the whole effective policy', async () => {
  const policy = {
    type: 'workspaceWrite', writableRoots: ['/work', '/extra'], networkAccess: false,
    readOnlyAccess: { type: 'fullAccess' }, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  }
  const { wire, peer } = harness({
    permissionMode: 'workspace-write',
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { ...threadResponse(params), sandbox: policy }
      return undefined
    },
  })
  await wire.initialize()
  await wire.startThread('/work')
  assert.equal(peer.paramsOf('thread/start').approvalPolicy, 'never')
  assert.equal(peer.paramsOf('thread/start').sandbox, 'workspace-write')
  assert.equal(wire.configuration?.matched, true)
  assert.deepEqual(wire.configuration?.effective.sandboxPolicy, policy)
  assert.deepEqual(wire.configuration?.missing, [])
  assert.deepEqual(wire.configuration?.mismatches, [])
  wire.close()
})

test('effective model mismatch is rejected without echoing untrusted protocol values', async () => {
  const { wire } = harness({
    model: 'requested-model',
    respond: (method, params) => method === 'initialize' ? {}
      : method === 'thread/start' ? { ...threadResponse(params), model: 'UNTRUSTED_PRIVATE_RESPONSE' } : undefined,
  })
  await wire.initialize()
  await assert.rejects(wire.startThread('/work'), (error: unknown) => {
    assert.match(String(error), /mismatched model/)
    assert.doesNotMatch(String(error), /UNTRUSTED_PRIVATE_RESPONSE/)
    return true
  })
  assert.deepEqual(wire.configuration?.mismatches, ['model'])
  wire.close()
})

test('cwd aliases for the same existing directory compare by physical identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-wire-cwd-'))
  try {
    const physical = join(dir, 'physical')
    const alias = join(dir, 'alias')
    mkdirSync(physical)
    symlinkSync(physical, alias)
    const { wire } = harness({
      respond: (method, params) => method === 'initialize' ? {}
        : method === 'thread/start' ? { ...threadResponse(params), cwd: physical } : undefined,
    })
    await wire.initialize()
    await wire.startThread(alias)
    assert.equal(wire.configuration?.matched, true)
    assert.equal(wire.configuration?.effective.cwd, physical)
    wire.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a relative effective cwd is invalid even when lexical resolution matches the request', async () => {
  const { wire } = harness({
    respond: (method, params) => method === 'initialize' ? {}
      : method === 'thread/start' ? { ...threadResponse(params), cwd: '.' } : undefined,
  })
  await wire.initialize()
  await assert.rejects(wire.startThread(process.cwd()), /missing or invalid cwd/)
  assert.deepEqual(wire.configuration?.missing, ['cwd'])
  wire.close()
})

test('per-turn effort has request evidence, never a fabricated effective value from thread history', async () => {
  const { wire } = harness({ respond: standardPeer() })
  await wire.initialize()
  await wire.startThread('/work')
  assert.equal(wire.configuration?.effective.reasoningEffort, 'low')
  await wire.runTurn(['review'], undefined, 'high')
  assert.equal(wire.turnId, 'turn-1')
  assert.deepEqual(wire.turnConfiguration, {
    requestedEffort: 'high', effectiveEffort: null, evidence: 'turn/start-request', accepted: true,
  })
  wire.close()
})

test('token usage is folded from cumulative totals and rate limits stay separate', async () => {
  const breakdown = (n: number) => ({
    totalTokens: n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0,
  })
  const { wire, peer } = harness({
    respond: (method, params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true }, model: params && (params as Record<string, unknown>).model, cwd: '/work', approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } }
      if (method === 'turn/start') {
        setImmediate(() => {
          self.notify('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { total: breakdown(100), last: breakdown(100), modelContextWindow: 272000 } })
          self.notify('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { total: breakdown(300), last: breakdown(300), modelContextWindow: 272000 } })
          self.notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 12 } } })
          self.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'FINAL' } })
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
  const usage = wire.usageReport
  assert.equal(usage.status, 'complete')
  assert.equal(usage.run?.totalTokens, 300)
  assert.deepEqual(usage.modelContextWindow, 272000)
  assert.equal(wire.rateLimitsReport.observations, 1)
  assert.deepEqual(wire.rateLimitsReport.latest, { primary: { usedPercent: 12 } })
})

test('a replay after turn/start request is still the resumed baseline', async () => {
  const breakdown = (n: number) => ({
    totalTokens: n, inputTokens: n - 10, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 10, reasoningOutputTokens: 0,
  })
  const { wire, peer } = harness({
    respond: (method, params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') {
        return {
          thread: { id: 'thread-7', ephemeral: false },
          model: params && (params as Record<string, unknown>).model,
          cwd: '/work', approvalPolicy: 'never', sandbox: { type: 'readOnly' },
        }
      }
      if (method === 'turn/start') {
        // The real 0.165 replay can arrive after the request but before its
        // response; the wire must buffer it until the turn id is authoritative.
        self.notify('thread/tokenUsage/updated', {
          threadId: 'thread-7', turnId: 'old-turn',
          tokenUsage: { total: breakdown(1000), last: breakdown(10), modelContextWindow: 272000 },
        })
        setImmediate(() => {
          self.notify('thread/tokenUsage/updated', {
            threadId: 'thread-7', turnId: 'turn-1',
            tokenUsage: { total: breakdown(1300), last: breakdown(300), modelContextWindow: 272000 },
          })
          self.notify('item/completed', { threadId: 'thread-7', turnId: 'turn-1',
            item: { type: 'agentMessage', phase: 'final_answer', text: 'FINAL' } })
          self.notify('turn/completed', { threadId: 'thread-7', turn: { id: 'turn-1', status: 'completed' } })
        })
        return { turn: { id: 'turn-1' } }
      }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.resumeThread('thread-7', { model: 'gpt-6.1-terra', cwd: '/work', permission: 'read-only' })
  peer.pump()
  const running = wire.runTurn(['go'])
  await new Promise((resolve) => { setImmediate(resolve) })
  peer.pump()
  await running
  const usage = wire.usageReport
  assert.equal(usage.status, 'complete')
  assert.equal(usage.replayedBaseline, true)
  assert.equal(usage.run?.totalTokens, 300)
})

test('a resumed thread treats a pre-turn usage replay as a baseline', async () => {
  const breakdown = (n: number) => ({
    totalTokens: n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0,
  })
  const { wire, peer } = harness({
    respond: (method, params, self) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') {
        self.notify('thread/tokenUsage/updated', { threadId: 'thread-7', turnId: 'old-turn', tokenUsage: { total: breakdown(1000), last: breakdown(1000), modelContextWindow: 272000 } })
        return { thread: { id: 'thread-7', ephemeral: false }, model: params && (params as Record<string, unknown>).model, cwd: '/work', approvalPolicy: 'never', sandbox: { type: 'readOnly' } }
      }
      if (method === 'turn/start') {
        setImmediate(() => {
          self.notify('thread/tokenUsage/updated', { threadId: 'thread-7', turnId: 'turn-1', tokenUsage: { total: breakdown(1300), last: breakdown(1300), modelContextWindow: 272000 } })
          self.notify('item/completed', { threadId: 'thread-7', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'FINAL' } })
          self.notify('turn/completed', { threadId: 'thread-7', turn: { id: 'turn-1', status: 'completed' } })
        })
        return { turn: { id: 'turn-1' } }
      }
      return undefined
    },
  })
  await wire.initialize()
  peer.pump()
  await wire.resumeThread('thread-7', { model: 'gpt-6.1-terra', cwd: '/work', permission: 'read-only' })
  peer.pump()
  const running = wire.runTurn(['go'])
  await new Promise((resolve) => { setImmediate(resolve) })
  peer.pump()
  await running
  const usage = wire.usageReport
  assert.equal(usage.status, 'complete')
  assert.equal(usage.replayedBaseline, true)
  assert.equal(usage.run?.totalTokens, 300)
})

test('wire associates live usage that precedes the turn/start response with the confirmed resumed turn', async () => {
  const breakdown = (total: number) => ({
    totalTokens: total, inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0,
  })
  const note = (turnId: string, total: number) => ({
    threadId: 'thread-7', turnId,
    tokenUsage: { total: breakdown(total), last: breakdown(1), modelContextWindow: 272000 },
  })
  const { wire } = harness({
    permissionMode: 'read-only', model: 'gpt-required',
    respond: (method, params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/resume') {
        peer.notify('thread/tokenUsage/updated', note('old-turn', 1000))
        return threadResponse(params, 'thread-7', false)
      }
      if (method === 'turn/start') {
        peer.notify('turn/started', { threadId: 'thread-7', turn: { id: 'turn-2' } })
        peer.notify('thread/tokenUsage/updated', note('turn-2', 1100))
        peer.notify('thread/tokenUsage/updated', note('turn-2', 1150))
        peer.notify('thread/tokenUsage/updated', note('turn-2', 1150))
        peer.notify('item/completed', { threadId: 'thread-7', turnId: 'turn-2', item: { type: 'agentMessage', phase: 'final_answer', text: 'FINAL' } })
        peer.notify('turn/completed', { threadId: 'thread-7', turn: { id: 'turn-2', status: 'completed' } })
        return { turn: { id: 'turn-2' } }
      }
      return undefined
    },
  })
  await wire.initialize()
  await wire.resumeThread('thread-7', { model: 'gpt-required', cwd: '/work', permission: 'read-only' })
  await wire.runTurn(['go'])
  assert.equal(wire.usageReport.status, 'complete')
  assert.equal(wire.usageReport.run?.totalTokens, 150)
  assert.equal(wire.usageReport.replayedBaseline, true)
  wire.close()
})

test('wire preserves malformed and missing-identity usage as partial instead of complete', async () => {
  const breakdown = { totalTokens: 100, inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
  const { wire, peer } = harness({
    respond: (method, params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params)
      if (method === 'turn/start') {
        peer.notify('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { total: breakdown } })
        peer.notify('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: null })
        peer.notify('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: breakdown } })
        peer.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'FINAL' } })
        peer.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        return { turn: { id: 'turn-1' } }
      }
      return undefined
    },
  })
  await wire.initialize()
  await wire.startThread('/work')
  await wire.runTurn(['go'])
  assert.equal(wire.usageReport.status, 'partial')
  assert.equal(wire.usageReport.run?.totalTokens, 100)
  wire.close()
  const closed = wire.usageReport
  peer.notify('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: null })
  assert.deepEqual(wire.usageReport, closed)
})

test('resumeThread refuses a reply about another thread', async () => {
  const { wire, peer } = harness({
    respond: (method, params) => {
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
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params, 'thread-5', false)
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
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params, 'thread-6', false)
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
    respond: (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return threadResponse(params, 'thread-7', false)
      if (method === 'thread/name/set') return FAIL
      return undefined
    },
  })
  await failing.wire.initialize()
  failing.peer.pump()
  await failing.wire.startThread('/work')
  assert.equal(await failing.wire.setThreadName('anything'), false)
})

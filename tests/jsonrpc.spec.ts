/**
 * The JSON-RPC transport, tested against a fake peer.
 *
 * The transport is the part of the protocol port that can be proven without
 * Codex: framing, correlation, cancellation, and the failure paths that would
 * otherwise leave a caller pending forever.
 *
 * @module dsh-subagent-codex-pro/tests/jsonrpc
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { LineTransport } from '../src/jsonrpc.ts'

/** One end of a pair of in-memory streams. */
class FakeStream extends EventEmitter {
  written = ''
  write(chunk: string): void {
    this.written += chunk
  }

  /** Push one chunk as the peer would. */
  feed(chunk: string): void {
    this.emit('data', chunk)
  }

  /** Every complete line the peer received, decoded. */
  get lines(): unknown[] {
    return this.written.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as unknown)
  }
}

/** A transport wired to a fake peer. */
function pair(hooks: ConstructorParameters<typeof LineTransport>[2] = {}): {
  transport: LineTransport
  toPeer: FakeStream
  fromPeer: FakeStream
} {
  const toPeer = new FakeStream()
  const fromPeer = new FakeStream()
  const transport = new LineTransport(toPeer, fromPeer, hooks)
  return { transport, toPeer, fromPeer }
}

test('a request resolves with the correlated response, whatever the order', async () => {
  const { transport, toPeer, fromPeer } = pair()
  const first = transport.request('a/one', { n: 1 })
  const second = transport.request('a/two', { n: 2 })
  const sent = toPeer.lines as { id: number; method: string; params: { n: number } }[]
  assert.equal(sent.length, 2)
  assert.equal(sent[0]!.method, 'a/one')
  assert.equal(sent[1]!.method, 'a/two')

  // Answer out of order: correlation is by id, not by arrival.
  fromPeer.feed(`${JSON.stringify({ jsonrpc: '2.0', id: sent[1]!.id, result: 'two' })}\n`)
  fromPeer.feed(`${JSON.stringify({ jsonrpc: '2.0', id: sent[0]!.id, result: 'one' })}\n`)
  assert.equal(await first, 'one')
  assert.equal(await second, 'two')
  assert.equal(transport.pendingCount, 0)
})

test('a response may arrive split across chunks', async () => {
  const { transport, toPeer, fromPeer } = pair()
  const pending = transport.request('a/split', {})
  const id = (toPeer.lines[0] as { id: number }).id
  const line = `${JSON.stringify({ jsonrpc: '2.0', id, result: { deep: 'value' } })}\n`
  for (const piece of [line.slice(0, 7), line.slice(7, 19), line.slice(19)]) fromPeer.feed(piece)
  assert.deepEqual(await pending, { deep: 'value' })
})

test('several messages in one chunk are all handled', async () => {
  const seen: string[] = []
  const { transport, fromPeer } = pair({ onNotification: (method) => { seen.push(method) } })
  fromPeer.feed('{"jsonrpc":"2.0","method":"x/one"}\n{"jsonrpc":"2.0","method":"x/two"}\n\n')
  assert.deepEqual(seen, ['x/one', 'x/two'])
  transport.dispose()
})

test('a malformed line is reported and skipped, not fatal', async () => {
  const problems: string[] = []
  const seen: string[] = []
  const { transport, toPeer, fromPeer } = pair({
    onNotification: (method) => { seen.push(method) },
    onProblem: (error) => { problems.push(error.message) },
  })
  const pending = transport.request('a/after', {})
  const id = (toPeer.lines[0] as { id: number }).id
  fromPeer.feed('this is not json\n')
  fromPeer.feed(`${JSON.stringify({ jsonrpc: '2.0', id, result: 'still works' })}\n`)
  assert.equal(await pending, 'still works')
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /undecodable/)
  assert.deepEqual(seen, [])
})

test('an error response rejects with its message and code', async () => {
  const { transport, toPeer, fromPeer } = pair()
  const pending = transport.request('a/fail', {})
  const id = (toPeer.lines[0] as { id: number }).id
  fromPeer.feed(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32_601, message: 'method not found' } })}\n`)
  await assert.rejects(async () => pending, /method not found \(code -32601\)/)
})

test('a request from the peer is answered with its result or its error', async () => {
  const { transport, toPeer, fromPeer } = pair({
    onRequest: (method) => {
      if (method === 'ok/echo') return { echoed: true }
      throw new Error('refused')
    },
  })
  fromPeer.feed('{"jsonrpc":"2.0","id":"p1","method":"ok/echo"}\n{"jsonrpc":"2.0","id":"p2","method":"bad"}\n')
  await new Promise((resolve) => { setImmediate(resolve) })
  const replies = toPeer.lines as { id: string; result?: unknown; error?: { message: string } }[]
  assert.deepEqual(replies.find((r) => r.id === 'p1')?.result, { echoed: true })
  assert.equal(replies.find((r) => r.id === 'p2')?.error?.message, 'refused')
  transport.dispose()
})

test('cancellation rejects only that request and stops listening', async () => {
  const { transport, toPeer, fromPeer } = pair()
  const controller = new AbortController()
  const pending = transport.request('a/cancel', {}, { signal: controller.signal })
  const id = (toPeer.lines[0] as { id: number }).id
  controller.abort()
  await assert.rejects(async () => pending, /was aborted/)
  // A late response must not resurrect it or throw.
  fromPeer.feed(`${JSON.stringify({ jsonrpc: '2.0', id, result: 'late' })}\n`)
  assert.equal(transport.pendingCount, 0)
})

test('dispose fails every in-flight request instead of leaving it pending', async () => {
  const { transport } = pair()
  const first = transport.request('a/one', {})
  const second = transport.request('a/two', {})
  transport.dispose(new Error('child exited'))
  await assert.rejects(async () => first, /child exited/)
  await assert.rejects(async () => second, /child exited/)
  // Afterwards the transport is closed for business.
  await assert.rejects(async () => transport.request('a/three', {}), /child exited/)
})

test('a write failure is reported and closes the transport', async () => {
  const problems: string[] = []
  const toPeer = new FakeStream()
  toPeer.write = () => { throw new Error('EPIPE') }
  const fromPeer = new FakeStream()
  const transport = new LineTransport(toPeer, fromPeer, { onProblem: (error) => { problems.push(error.message) } })
  await assert.rejects(async () => transport.request('a/write', {}), /write failed: EPIPE/)
  assert.equal(problems.length, 1)
})

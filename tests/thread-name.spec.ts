import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readableThreadName } from '../src/thread-name.ts'

test('thread names are single-line, readable and bounded by UTF-8 bytes', () => {
  assert.equal(readableThreadName('  DSH · probe\nsecond line  ', '/tmp/work'), 'DSH · probe second line')
  assert.equal(readableThreadName('title\u0000with\u0007controls', '/tmp/work'), 'title with controls')
  assert.equal(readableThreadName('', '/tmp/work'), 'DSH · work · Codex delegation')

  const long = readableThreadName('🚨'.repeat(1_000), '/tmp/work')
  assert.ok(Buffer.byteLength(long) <= 1024)
  assert.ok(long.startsWith('🚨'))
  assert.equal(long.includes('\n'), false)
})

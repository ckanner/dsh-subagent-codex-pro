/**
 * Result-envelope rules that are easy to regress.
 *
 * A schema-constrained answer is machine-readable JSON. Human-text convenience
 * (the persistent-thread marker) must never be appended to it, while a plain
 * answer keeps the marker that makes a thread continuable.
 *
 * @module dsh-subagent-codex-pro/tests/result
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { withThreadMarker } from '../src/index.ts'

const json = '{"verdict":"pass","count":2}'

test('a schema-constrained answer is never polluted with a thread marker', () => {
  const formatted = withThreadMarker({ text: json, threadId: 'thread-7' }, 'persistent', true)
  assert.equal(formatted, json)
  assert.equal(JSON.parse(formatted).verdict, 'pass')
})

test('a human persistent answer still carries its thread marker', () => {
  const formatted = withThreadMarker({ text: 'DONE', threadId: 'thread-7' }, 'persistent', false)
  assert.match(formatted, /^DONE\n\n\[codex thread thread-7/)
})

test('ephemeral answers and missing thread ids carry no marker', () => {
  assert.equal(withThreadMarker({ text: 'DONE', threadId: 'thread-7' }, 'ephemeral', false), 'DONE')
  assert.equal(withThreadMarker({ text: 'DONE', threadId: undefined }, 'persistent', false), 'DONE')
})

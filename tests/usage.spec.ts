/**
 * Token-usage accounting.
 *
 * Codex reports thread-cumulative snapshots (`total`) that resume replays before
 * a new turn. These cases pin the accounting rules: a replay is a baseline, a
 * later cumulative total produces this run's delta, duplicates/out-of-order
 * snapshots never add, and a missing baseline is unknown rather than zero.
 *
 * @module dsh-subagent-codex-pro/tests/usage
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TokenUsageTracker } from '../src/usage.ts'

/** One exact Codex breakdown. */
function usage(total: number, extra: Partial<Record<'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningOutputTokens', number>> = {}): {
  total: {
    totalTokens: number
    inputTokens: number
    cachedInputTokens: number
    cacheWriteInputTokens: number
    outputTokens: number
    reasoningOutputTokens: number
  }
  modelContextWindow: number
} {
  const inputTokens = extra.inputTokens ?? (total > 0 ? total - 10 : 0)
  const outputTokens = extra.outputTokens ?? (total > 0 ? 10 : 0)
  return {
    total: {
      totalTokens: total,
      inputTokens,
      cachedInputTokens: extra.cachedInputTokens ?? 0,
      cacheWriteInputTokens: 0,
      outputTokens,
      reasoningOutputTokens: extra.reasoningOutputTokens ?? 0,
    },
    modelContextWindow: 272_000,
  }
}

const note = (turnId: string, total: number) => ({ turnId, tokenUsage: usage(total), threadId: 'thread-1' })

test('a brand-new thread starts from a known zero baseline', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread()
  tracker.beginTurn('turn-1')
  tracker.observe(note('turn-1', 100))
  tracker.observe(note('turn-1', 300))

  const report = tracker.report()
  assert.equal(report.status, 'complete')
  assert.deepEqual(report.run, usage(300).total)
  assert.deepEqual(report.threadTotal, usage(300).total)
  assert.equal(report.replayedBaseline, false)
})

test('a replayed resume snapshot is a baseline, never new spending', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume()
  // The connection-scoped replay arrives before the new turn: this is history.
  tracker.observe(note('old-turn', 1000))
  tracker.beginTurn('turn-2')
  tracker.observe(note('turn-2', 1300))

  const report = tracker.report()
  assert.equal(report.status, 'complete')
  assert.equal(report.replayedBaseline, true)
  assert.equal(report.run?.totalTokens, 300)
  assert.equal(report.threadTotal?.totalTokens, 1300)
})

test('a resume without a replay is partial, not a fabricated delta', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume()
  tracker.beginTurn('turn-2')
  tracker.observe(note('turn-2', 1000))

  const first = tracker.report()
  assert.equal(first.status, 'partial')
  assert.equal(first.run, undefined)

  tracker.observe(note('turn-2', 1300))
  const later = tracker.report()
  assert.equal(later.status, 'partial')
  assert.equal(later.run?.totalTokens, 300)
})

test('duplicate and out-of-order snapshots never add', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread()
  tracker.beginTurn('turn-1')
  tracker.observe(note('turn-1', 100))
  tracker.observe(note('turn-1', 100))
  tracker.observe(note('turn-1', 300))
  tracker.observe(note('turn-1', 300))
  assert.equal(tracker.report().run?.totalTokens, 300)

  // A counter that moves backwards is a reset, not negative usage.
  tracker.observe(note('turn-1', 250))
  const reset = tracker.report()
  assert.equal(reset.status, 'partial')
  assert.equal(reset.run, undefined)
})

test('usage for another turn after ours begins is ignored', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread()
  tracker.beginTurn('turn-1')
  tracker.observe(note('turn-1', 100))
  tracker.observe(note('turn-other', 9000))
  tracker.observe(note('turn-1', 300))

  assert.equal(tracker.report().run?.totalTokens, 300)
})

test('no observation is unknown, never zero', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread()
  tracker.beginTurn('turn-1')
  const report = tracker.report()
  assert.equal(report.status, 'unknown')
  assert.equal(report.run, undefined)
})

test('replay alone is unknown, and the historical total is retained', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume()
  tracker.observe(note('old-turn', 1000))
  const report = tracker.report()
  assert.equal(report.status, 'unknown')
  assert.equal(report.run, undefined)
  assert.equal(report.threadTotal?.totalTokens, 1000)
})

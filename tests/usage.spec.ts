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
  tracker.resetForNewThread('thread-1')
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
  tracker.resetForResume('thread-1')
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
  tracker.resetForResume('thread-1')
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
  tracker.resetForNewThread('thread-1')
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

test('another turn on this thread prevents reliable cumulative attribution', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread('thread-1')
  tracker.beginTurn('turn-1')
  tracker.observe(note('turn-1', 100))
  tracker.observe(note('turn-other', 9000))
  tracker.observe(note('turn-1', 300))

  assert.equal(tracker.report().status, 'partial')
  assert.equal(tracker.report().run, undefined)
  assert.match(tracker.report().reason ?? '', /another turn/)
})

test('no observation is unknown, never zero', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread('thread-1')
  tracker.beginTurn('turn-1')
  const report = tracker.report()
  assert.equal(report.status, 'unknown')
  assert.equal(report.run, undefined)
})

test('replay alone is unknown, and the historical total is retained', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume('thread-1')
  tracker.observe(note('old-turn', 1000))
  const report = tracker.report()
  assert.equal(report.status, 'unknown')
  assert.equal(report.run, undefined)
  assert.equal(report.threadTotal?.totalTokens, 1000)
})

test('a malformed observation after valid usage retains only a partial known amount', () => {
  const { cacheWriteInputTokens: missing, ...withoutCacheWrites } = usage(200).total
  assert.equal(missing, 0)
  for (const tokenUsage of [null, {}, usage(-1), { total: { totalTokens: 200 } }, { total: withoutCacheWrites }]) {
    const tracker = new TokenUsageTracker()
    tracker.resetForNewThread('thread-1')
    tracker.beginTurn('turn-1')
    tracker.observe(note('turn-1', 100))
    tracker.observe({ threadId: 'thread-1', turnId: 'turn-1', tokenUsage })
    assert.equal(tracker.report().status, 'partial')
    assert.equal(tracker.report().run?.totalTokens, 100)
    assert.match(tracker.report().reason ?? '', /malformed/)
  }
})

test('invalid protocol notifications cannot leave a complete report', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread('thread-1')
  tracker.beginTurn('turn-1')
  tracker.observe(note('turn-1', 100))
  tracker.observeInvalid()
  tracker.observe(note('turn-1', 200))
  assert.equal(tracker.report().status, 'partial')
  assert.equal(tracker.report().run?.totalTokens, 200)
})

test('another thread is ignored without changing this thread usage or completeness', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread('thread-1')
  tracker.beginTurn('turn-1')
  tracker.observe(note('turn-1', 100))
  tracker.observe({ ...note('turn-1', 9000), threadId: 'thread-other' })
  tracker.observe({ threadId: 'thread-other', tokenUsage: null })
  assert.equal(tracker.report().status, 'complete')
  assert.equal(tracker.report().run?.totalTokens, 100)
  assert.equal(tracker.report().observations, 1)
})

test('a missing thread identity cannot be attributed to the active run', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread('thread-1')
  tracker.beginTurn('turn-1')
  tracker.observe(note('turn-1', 100))
  tracker.observe({ turnId: 'turn-1', tokenUsage: usage(9000) })
  assert.equal(tracker.report().status, 'partial')
  assert.equal(tracker.report().run?.totalTokens, 100)
})

test('a new thread attributes pre-response live usage after the turn id is confirmed', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread('thread-1')
  tracker.startTurnRequest()
  tracker.observe(note('turn-1', 100))
  tracker.observe(note('turn-1', 300))
  assert.equal(tracker.report().status, 'unknown')
  tracker.beginTurn('turn-1')
  assert.equal(tracker.report().status, 'complete')
  assert.equal(tracker.report().run?.totalTokens, 300)
})

test('resumed live usage before turn/start response is not mistaken for history', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume('thread-1')
  tracker.observe(note('old-turn', 1000))
  tracker.startTurnRequest()
  tracker.observe(note('turn-2', 1100))
  tracker.observe(note('turn-2', 1150))
  tracker.observe(note('turn-2', 1150))
  tracker.beginTurn('turn-2')
  assert.equal(tracker.report().status, 'complete')
  assert.equal(tracker.report().run?.totalTokens, 150)
  assert.equal(tracker.report().replayedBaseline, true)
})

test('early resumed live usage without history remains partial', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume('thread-1')
  tracker.startTurnRequest()
  tracker.observe(note('turn-2', 1100))
  tracker.observe(note('turn-2', 1150))
  tracker.beginTurn('turn-2')
  assert.equal(tracker.report().status, 'partial')
  assert.equal(tracker.report().replayedBaseline, false)
  assert.equal(tracker.report().run?.totalTokens, 50)
})

test('a replay arriving after turn/start is still the resumed baseline', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume('thread-1')
  tracker.startTurnRequest()
  tracker.observe(note('old-turn', 1000))
  tracker.beginTurn('turn-2')
  tracker.observe(note('turn-2', 1300))
  assert.equal(tracker.report().status, 'complete')
  assert.equal(tracker.report().replayedBaseline, true)
  assert.equal(tracker.report().run?.totalTokens, 300)
  assert.equal(tracker.report().threadTotal?.totalTokens, 1300)
})

test('a historical snapshot after a live current-turn snapshot stays unattributed', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume('thread-1')
  tracker.startTurnRequest()
  tracker.beginTurn('turn-2')
  tracker.observe(note('turn-2', 1100))
  tracker.observe(note('different-turn', 9000))
  assert.equal(tracker.report().status, 'partial')
  assert.equal(tracker.report().replayedBaseline, false)
  assert.equal(tracker.report().run, undefined)
})

test('a historical snapshot arriving after the turn id is confirmed is the resumed baseline', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume('thread-1')
  tracker.startTurnRequest()
  tracker.beginTurn('turn-2')
  tracker.observe(note('old-turn', 1000))
  tracker.observe(note('turn-2', 1300))
  assert.equal(tracker.report().status, 'complete')
  assert.equal(tracker.report().replayedBaseline, true)
  assert.equal(tracker.report().run?.totalTokens, 300)
})

test('the latest valid replay before submission is the resumed baseline', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume('thread-1')
  tracker.observe(note('old-turn', 1000))
  tracker.observe(note('old-turn', 1100))
  tracker.observe(note('old-turn', 1100))
  tracker.startTurnRequest()
  tracker.beginTurn('turn-2')
  tracker.observe(note('turn-2', 1150))
  assert.equal(tracker.report().status, 'complete')
  assert.equal(tracker.report().run?.totalTokens, 50)
})

test('closing freezes the report against late valid and invalid notifications', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForNewThread('thread-1')
  tracker.beginTurn('turn-1')
  tracker.observe(note('turn-1', 100))
  tracker.close()
  const before = tracker.report()
  tracker.observe(note('turn-1', 9000))
  tracker.observeInvalid()
  assert.deepEqual(tracker.report(), before)
})

test('unknown or lost association never becomes zero consumption', () => {
  const tracker = new TokenUsageTracker()
  tracker.resetForResume('thread-1')
  tracker.observeInvalid()
  assert.equal(tracker.report().status, 'unknown')
  assert.equal(tracker.report().run, undefined)
  tracker.resetForNewThread('thread-1')
  tracker.startTurnRequest()
  for (let i = 0; i < 130; i++) tracker.observe(note('turn-1', i + 100))
  tracker.beginTurn('turn-1')
  assert.equal(tracker.report().status, 'partial')
  assert.equal(tracker.report().run?.totalTokens, 227)
  assert.match(tracker.report().reason ?? '', /too many/)
})

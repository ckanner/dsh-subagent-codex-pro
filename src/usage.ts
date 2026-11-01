/**
 * Token usage observed over one delegation.
 *
 * Codex reports a thread-cumulative snapshot (`total`) and a last-model-call
 * snapshot (`last`) through `thread/tokenUsage/updated`. A delegation can make
 * several model calls, so `last` is never a delegation total, and `total` is an
 * absolute high-water mark rather than an increment. Resume/attach replays the
 * latest persisted snapshot for the new connection, so the first observation
 * after a resume is history, not this run.
 *
 * The tracker therefore:
 * - uses a baseline and computes a delta from later cumulative snapshots;
 * - treats a replay after resume as the baseline;
 * - ignores duplicate and out-of-order snapshots;
 * - never derives a value by adding snapshots;
 * - reports `unknown` rather than zero when no usable observation exists;
 * - retains the last observed totals even when the run failed or was cancelled.
 *
 * `cachedInputTokens` is a subset of `inputTokens`, and
 * `reasoningOutputTokens` is a subset of `outputTokens`. The fields are reported
 * as Codex states them; they are never summed into a larger total.
 *
 * @module dsh-subagent-codex-pro/usage
 */

/** One token-usage breakdown exactly as Codex reports it. */
export interface TokenUsageBreakdown {
  readonly totalTokens: number
  readonly inputTokens: number
  /** Cached input, already included in `inputTokens`. */
  readonly cachedInputTokens: number
  /** Cache writes, already included in `inputTokens`. */
  readonly cacheWriteInputTokens: number
  readonly outputTokens: number
  /** Reasoning output, already included in `outputTokens`. */
  readonly reasoningOutputTokens: number
}

/** Whether a usage report covers the whole delegation, part of it, or nothing. */
export type UsageStatus = 'complete' | 'partial' | 'unknown'

/**
 * Usage attributable to one delegation.
 *
 * `run` is the delta from the observed baseline, not a sum of notifications.
 * `threadTotal` is the latest absolute thread snapshot, kept for diagnostics.
 * A report with `status: 'unknown'` deliberately has no `run`; it is not zero.
 */
export interface CodexUsageReport {
  readonly status: UsageStatus
  /** The usage of this run, when a baseline and at least one later snapshot exist. */
  readonly run?: TokenUsageBreakdown
  /** The latest thread-cumulative snapshot observed, including pre-run history. */
  readonly threadTotal?: TokenUsageBreakdown
  /** Thread model context window when Codex reported it. */
  readonly modelContextWindow?: number | null
  /** Usable usage notifications observed for this thread. */
  readonly observations: number
  /** Whether a resumed thread's baseline came from a replay notification. */
  readonly replayedBaseline: boolean
  /** Why the report is partial or unknown. */
  readonly reason?: string
}

/** The shape of `thread/tokenUsage/updated` the wire accepts. */
export interface TokenUsageNotificationLike {
  readonly threadId?: unknown
  readonly turnId?: unknown
  readonly tokenUsage?: unknown
}

const BREAKDOWN_FIELDS = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const

/** A zero breakdown, used as the known baseline of a brand-new thread. */
const ZERO: TokenUsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
}

/** Whether a value is a non-negative safe integer. */
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Normalise a reported breakdown, applying Codex's documented default for the
 * one optional counter. `cacheWriteInputTokens` is the only field the protocol
 * does not require; the other five must be present and non-negative.
 */
function normalizeBreakdown(value: unknown): TokenUsageBreakdown | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const cacheWrite = record.cacheWriteInputTokens === undefined ? 0 : record.cacheWriteInputTokens
  if (!count(record.totalTokens) || !count(record.inputTokens) || !count(record.cachedInputTokens)
    || !count(record.outputTokens) || !count(record.reasoningOutputTokens) || !count(cacheWrite)) {
    return undefined
  }
  return {
    totalTokens: record.totalTokens,
    inputTokens: record.inputTokens,
    cachedInputTokens: record.cachedInputTokens,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: record.outputTokens,
    reasoningOutputTokens: record.reasoningOutputTokens,
  }
}

/** Subtract one breakdown from another; returns undefined when any field goes backwards. */
function subtract(later: TokenUsageBreakdown, earlier: TokenUsageBreakdown): TokenUsageBreakdown | undefined {
  const result = {
    totalTokens: later.totalTokens - earlier.totalTokens,
    inputTokens: later.inputTokens - earlier.inputTokens,
    cachedInputTokens: later.cachedInputTokens - earlier.cachedInputTokens,
    cacheWriteInputTokens: later.cacheWriteInputTokens - earlier.cacheWriteInputTokens,
    outputTokens: later.outputTokens - earlier.outputTokens,
    reasoningOutputTokens: later.reasoningOutputTokens - earlier.reasoningOutputTokens,
  }
  return BREAKDOWN_FIELDS.every((field) => result[field] >= 0) ? result : undefined
}

/** Whether every counter in `later` is at least its counterpart in `earlier`. */
function notOlder(later: TokenUsageBreakdown, earlier: TokenUsageBreakdown): boolean {
  return BREAKDOWN_FIELDS.every((field) => later[field] >= earlier[field])
}

/** One notification accepted by the tracker. */
export interface UsageObservation {
  readonly turnId: string
  readonly tokenUsage: unknown
  readonly modelContextWindow?: unknown
}

/**
 * Fold the usage notifications of one thread into one delegation report.
 *
 * One tracker belongs to one wire/thread. `resetForNewThread` is called after a
 * successful `thread/start`; `resetForResume` after a successful
 * `thread/resume`; `beginTurn` when the turn id becomes authoritative. The
 * tracker is deliberately not a Codex client: it only accounts for snapshots,
 * never issues requests.
 */
export class TokenUsageTracker {
  #mode: 'new' | 'resumed' = 'new'
  #state: 'collecting' | 'closed' = 'collecting'
  #baselineKnown = true
  #baseline: TokenUsageBreakdown = ZERO
  #latest: TokenUsageBreakdown | undefined
  #highWater: TokenUsageBreakdown = ZERO
  #modelContextWindow: number | null | undefined
  #observations = 0
  #replaySeen = false
  #baselineFromLive = false
  #liveSeen = false
  #advanced = false
  #anomaly = false
  #reason: string | undefined
  #turnId: string | undefined

  /** Start accounting for a thread that has no history. */
  resetForNewThread(): void {
    this.#mode = 'new'
    this.#state = 'collecting'
    this.#baselineKnown = true
    this.#baseline = ZERO
    this.#latest = undefined
    this.#highWater = ZERO
    this.#modelContextWindow = undefined
    this.#observations = 0
    this.#replaySeen = false
    this.#baselineFromLive = false
    this.#liveSeen = false
    this.#advanced = false
    this.#anomaly = false
    this.#reason = undefined
    this.#turnId = undefined
  }

  /**
   * Start accounting for a resumed thread.
   *
   * Its first usage notification is normally the connection-scoped replay of
   * the last persisted snapshot, so it becomes the baseline and contributes no
   * run usage. If no replay arrives before the turn starts, the first live
   * snapshot is still used as a baseline but the report is `partial`, because
   * usage before that snapshot is unknowable from the protocol.
   */
  resetForResume(): void {
    this.resetForNewThread()
    this.#mode = 'resumed'
    this.#baselineKnown = false
    this.#baseline = ZERO
  }

  /** Record the authoritative turn id; notifications before this are history. */
  beginTurn(turnId: string): void {
    this.#turnId = turnId
  }

  /** The current turn id, when the wire has adopted it. */
  get turnId(): string | undefined {
    return this.#turnId
  }

  /** The latest absolute thread total, if any observation was accepted. */
  get latest(): TokenUsageBreakdown | undefined {
    return this.#latest
  }

  /** The latest model context window, if Codex reported one. */
  get modelContextWindow(): number | null | undefined {
    return this.#modelContextWindow
  }

  /** Begin a report's closing fold; further observations are ignored. */
  close(): void {
    this.#state = 'closed'
  }

  /**
   * Fold one `thread/tokenUsage/updated` notification.
   *
   * @param notification - the decoded notification parameters.
   * @returns whether the notification was usable for accounting.
   */
  observe(notification: TokenUsageNotificationLike): boolean {
    if (this.#state === 'closed') return false
    const turnId = typeof notification.turnId === 'string' && notification.turnId !== ''
      ? notification.turnId
      : undefined
    const total = this.#totalOf(notification.tokenUsage)
    if (turnId === undefined || total === undefined) {
      this.#reason = 'Codex reported a malformed token-usage notification'
      return false
    }
    this.#observations += 1
    const modelContextWindow = this.#contextWindowOf(notification.tokenUsage)
    if (modelContextWindow !== undefined) this.#modelContextWindow = modelContextWindow

    // A resumed thread's history arrives before its new turn starts. Adopt that
    // snapshot as the baseline; it is not local consumption.
    if (this.#mode === 'resumed' && !this.#replaySeen
      && (this.#turnId === undefined || turnId !== this.#turnId)) {
      this.#baseline = total
      this.#baselineKnown = true
      this.#replaySeen = true
      this.#highWater = total
      this.#latest = total
      return true
    }

    this.#liveSeen = true

    // No replay arrived before the turn; the first live snapshot is the best
    // baseline available, but usage before it was never observed.
    if (!this.#baselineKnown) {
      this.#baseline = total
      this.#baselineKnown = true
      this.#baselineFromLive = true
      this.#reason = 'the resumed thread did not replay a baseline before its first live usage'
      this.#highWater = total
      this.#latest = total
      return false
    }

    // A snapshot for another turn after ours began cannot be attributed to this
    // delegation. The notification is still counted as observed, but not added.
    if (this.#turnId !== undefined && turnId !== this.#turnId) {
      this.#reason = 'usage for another turn was ignored'
      return false
    }

    if (!notOlder(total, this.#highWater)) {
      // Counters may reset when a thread is rolled back or rebuilt. Keeping a
      // negative delta would fabricate a negative or inflated result; restart
      // the baseline and report partial rather than a clean number.
      this.#anomaly = true
      this.#baseline = total
      this.#highWater = total
      this.#latest = total
      this.#reason = 'a usage counter moved backwards; the run total is partial'
      return false
    }
    if (!BREAKDOWN_FIELDS.some((field) => total[field] > this.#highWater[field])) {
      // Duplicate or older snapshot: same high-water mark, no new information.
      this.#latest = total
      return true
    }
    this.#highWater = total
    this.#latest = total
    this.#advanced = true
    return true
  }

  /** Record a malformed notification so the report can say so. */
  observeInvalid(): void {
    this.#reason = 'Codex reported an invalid token-usage notification'
  }

  /**
   * The report for this run.
   *
   * No observation is `unknown`, never a zero report. A known baseline plus a
   * later snapshot is `complete` unless a reset/partial reason was recorded.
   */
  report(): CodexUsageReport {
    const latest = this.#latest
    if (latest === undefined || !this.#liveSeen) {
      return {
        status: 'unknown',
        observations: this.#observations,
        replayedBaseline: this.#replaySeen,
        ...(latest === undefined ? {} : { threadTotal: latest }),
        reason: latest === undefined
          ? (this.#reason ?? 'no token-usage notification was observed')
          : 'only replayed historical usage was observed',
      }
    }
    const delta = this.#baselineKnown && !this.#anomaly && !(this.#baselineFromLive && !this.#advanced)
      ? subtract(latest, this.#baseline)
      : undefined
    const partial = delta === undefined || this.#anomaly || this.#baselineFromLive || !this.#baselineKnown
    return {
      status: partial ? 'partial' : 'complete',
      ...(delta === undefined ? {} : { run: delta }),
      threadTotal: latest,
      ...(this.#modelContextWindow === undefined ? {} : { modelContextWindow: this.#modelContextWindow }),
      observations: this.#observations,
      replayedBaseline: this.#replaySeen,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
    }
  }

  /** Validate and copy the reported breakdown. */
  #totalOf(tokenUsage: unknown): TokenUsageBreakdown | undefined {
    if (typeof tokenUsage !== 'object' || tokenUsage === null || Array.isArray(tokenUsage)) return undefined
    const total = (tokenUsage as Record<string, unknown>).total
    return normalizeBreakdown(total)
  }

  /** Read `modelContextWindow` from a reported usage object. */
  #contextWindowOf(tokenUsage: unknown): number | null | undefined {
    if (typeof tokenUsage !== 'object' || tokenUsage === null || Array.isArray(tokenUsage)) return undefined
    const value = (tokenUsage as Record<string, unknown>).modelContextWindow
    return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      ? value
      : undefined
  }
}

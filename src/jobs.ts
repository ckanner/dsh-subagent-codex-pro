/**
 * Job settlement for one background delegation.
 *
 * The jobs contract is specific and unforgiving: a producer's `done` must
 * resolve to a `JobOutcome` — `{ status, detail?, result? }` — and it must never
 * reject. Returning the delegation's text directly leaves a bare string where the
 * registry expects that record, which then fails validation on *every* read of
 * the job, so `job_output` **and** `job_list` both report "value is not lossless
 * JSON" and the model can never collect its own result.
 *
 * @module dsh-subagent-codex-pro/jobs
 */

/** The settlement record a producer's `done` must resolve to. */
export interface JobOutcomeLike {
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string
  /** The delegation's final message, handed out once by the model's next read. */
  readonly result?: string
}

/**
 * Wrap one delegation as a job outcome.
 *
 * Never rejects: the contract requires a settlement record even when the work
 * failed, so a rejection becomes `status: 'failed'` with the reason in `detail`.
 *
 * @param delegation - the running delegation's promise.
 * @returns the outcome record the jobs registry accepts.
 */
export async function settleJob(delegation: Promise<string>): Promise<JobOutcomeLike> {
  try {
    const result = await delegation
    return { status: 'completed', result }
  } catch (error: unknown) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

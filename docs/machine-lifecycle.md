# Typed lifecycle and read-only recovery (lifecycle 1)

This contract is in the **0.9.0 unreleased source candidate**. The public
`dsh-subagent-codex-pro/machine` result protocol stays 1. Lifecycle is a separate,
versioned JavaScript API capability; the single-document CLI and existing DSH
Host/tool results do not silently become a duplex protocol.

## Opt in explicitly

`runMachine(request, options)` additionally accepts:

- `onLifecycle(event)`: an awaited programmatic checkpoint. Resolve only after
  the owning engine has atomically saved and fsynced its correlated checkpoint.
  Reject to refuse the handoff. This is not a new human approval prompt.
- `recoveryDirectory`: the **new** private directory for this one invocation.
  Its absolute canonical parent must already exist. Existing directories,
  aliases and symlinks are refused; the API never reuses an old journal to run
  another turn. Use a unique engine invocation ID, not the thread ID, for naming.

When either option is present, an independent POSIX machine supervisor owns the
native runner and final persistence. It is separate from the caller's process
group and establishes an IPC lifeline before work starts. If the caller dies,
its pending acknowledgement is rejected, the native run is cancelled, and the
supervisor waits for the existing Codex guardian to finish group cleanup before
saving the observed receipt. A process signal is not a model outcome.

```js
import {
  runMachine, recoverMachine, MACHINE_LIFECYCLE_VERSION,
  MACHINE_LIFECYCLE_CAPABILITIES,
} from 'dsh-subagent-codex-pro/machine'

// request and recoveryDirectory belong to this unique engine invocation.
const receipt = await runMachine(request, {
  recoveryDirectory,
  signal: controller.signal,
  onLifecycle: event => engine.persistCheckpointAndFsync(event),
})
// If the caller later loses its terminal handoff, use the run ID already saved
// in its own checkpoint. This reads the journal without running a new turn.
const recovered = await recoverMachine({
  protocol: 1, requestId: request.requestId, runId: savedCheckpoint.runId,
  recoveryDirectory,
})
```

`MACHINE_LIFECYCLE_VERSION` is 1. Capabilities are `{version:1,
 durableJournal:true, readOnlyRecovery:true, threadReadyBeforeDispatch:true}`.
They are an API declaration, not proof that a particular account, history or
machine has passed a live acceptance test.

## Events and barriers

Every event contains `lifecycleVersion:1`, `type:'lifecycle'`, `requestId`,
`runId`, consecutive `sequence` starting at 1, `event`, `threadId`, `turnId`,
`persistent`, `configuration`, `dispatch`, `outcome`, and `cleanupConfirmed`.
IDs remain correlated to the original invocation. `persistent` names the
requested mode; it does not claim that an empty new thread has a resumable
rollout. Configuration retains the actual `thread/start` or `thread/resume`
response evidence, including the full sandbox policy and whether it matched.
Thread creation requires an explicit matching boolean `ephemeral` observation;
resume requires the requested history to be accepted and effective overrides to
match. No current-turn effort is invented from historical thread defaults.

| Event | Meaning and ordering |
| --- | --- |
| `thread-ready` | Thread identity and effective configuration have been checked. No new turn has been sent. Its ACK is awaited. |
| `dispatch-intent` | The supervisor is ready to submit this exact turn. No turn has been sent. Its ACK is awaited. |
| `dispatch-possible` | Saved **before** the turn request write. Its ACK is awaited, but the subsequent send/ack crash window stays `possible`. |
| `turn-accepted` | A matching `turn/start` reply has supplied the current turn ID. This is acceptance, not completion. |
| `terminal` | The original native result and cleanup observations have been collected and the complete receipt has already been fsynced, when a journal was requested. |
| `cleanup-confirmed` | Emitted only when native cleanup was actually confirmed, after the receipt was saved. The caller may now save its original candidate/guard proof before ACK. |

Terminal delivery occurs after native settlement; it is not an earlier streaming
terminal notification. `terminal` and `cleanup-confirmed` carry the same final
facts. Delivery rejection or caller death at either final notification does not
rewrite an already completed native turn as cancelled. The original receipt is
kept intact and remains available to the read-only entry.

A startup failure may reach `terminal` before `thread-ready`. A failed native
turn can remain `unknown` even after its processes have stopped. The
`execution.dispatch` field and lifecycle dispatch distinguish `not-dispatched`,
`possible`, and `accepted`. In particular, rejection at the possible-send barrier
remains conservatively `possible`, even if a local test observes no turn write.
The engine must not infer zero consumption or replay safety from an error string.

The native deadline still bounds startup and pre-turn callbacks. The supervisor
also bounds admission and each checkpoint handoff to 10 seconds, including final
ACKs after native cleanup. A disconnected caller rejects the current waiter
immediately; no pending callback can strand native cleanup indefinitely.

## Journal and recovery semantics

The supervisor creates a mode-0700 directory exclusively. Evidence is a bounded
mode-0600 JSON record, written to an exclusive temporary file, fsynced, renamed
atomically and followed by a directory fsync. The newly created directory's
parent is fsynced too. Each record has a SHA-256 integrity check and exact
request/run identity. The journal is evidence, not an orchestration state file;
it never writes the engine's state, budgets or candidate decisions.

`recoverMachine({protocol:1,requestId,runId,recoveryDirectory})` strictly validates
its arguments and reads exactly that journal. It never starts a process, sends
network traffic, resumes a thread, searches account history, kills a PID, changes
files, or retries execution. A known run ID is required. The API does not use PID
existence to prove either ownership or cleanup.

| Recovery status | What can be concluded |
| --- | --- |
| `terminal` | `receipt` is the original complete stored machine receipt; the caller must validate configuration, result, independent cleanup and usage before applying it. It may be a failure or have unknown outcome/cleanup. |
| `pending` | A matching valid journal exists without a terminal receipt. This does **not** prove that its owner is alive, its turn is running, or that replay is safe. |
| `unknown` | Evidence is absent, inaccessible, corrupt or identity-mismatched. No dispatch or cleanup conclusion is fabricated. |

The result also contains the most recent durable `lifecycle` event and a bounded
reason. That event was saved **before** delivery to the caller, so its existence
does not prove that the engine acknowledged it. Only the engine's own checkpoint
can establish that its candidate/guard/report proof was saved at the original
cleanup boundary. If that proof is missing, the engine may account attributable
usage without reinterpreting current workspace files as old verification.

An interrupted parent can usually recover the supervisor's later receipt. If the
machine supervisor also dies before saving one, its native guardian may still
clean up physically, but recovery must stay incomplete. Simultaneous supervisor
loss, unknown run IDs, escaped process groups, missing histories, and power loss
outside the filesystem's fsync guarantees are not an exactly-once execution
contract. Both resume and fresh replay must remain blocked until the owning
engine has sufficient evidence. `requestId` is correlation, not provider-side
deduplication.

## Storage and verification

The caller owns retention and deletion. Retain each journal until its terminal
receipt has been applied/accounted once and the task's audit retention has
expired; never delete evidence for unresolved execution just to enable a retry.
No history scanner or background janitor runs on import. Requested credentials
are not copied to the journal, but raw model output remains raw and can contain
sensitive user content; place the private parent in the intended task evidence
area and apply the caller's retention policy.

The offline suite uses real supervised fixture processes. It verifies awaited
checkpoints, rejected ACKs, exclusive admission, read-only recovery, corruption,
caller process-group SIGKILL, unchanged successful receipts after lost final
notification, and the actual installed package's compiled supervisor. These
checks do not constitute live Codex account, billing, desktop, cache or quality
measurements. See [the validation record](machine-lifecycle-validation.md).

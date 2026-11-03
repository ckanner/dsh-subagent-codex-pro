# Machine API and CLI (protocol 1)

Version 0.8.0 adds a public entry for orchestrators that need the complete outcome
without a DSH parent Agent. It uses the same app-server runner, configuration
checks, usage tracker and process guardian as the DSH provider and tool.

## Install and inspect

After 0.8.0 is published:

```sh
npm install dsh-subagent-codex-pro@0.8.0
npx --no-install codex-pro-machine --capabilities
```

For a source checkout, build and pack it, then install that tarball in a
separate test project. A checkout is not evidence that npm has this version.
Node 22.18+ is required. The Codex executable and its normal authentication must
already be available; this package neither installs Codex nor copies credentials.
Use an absolute command path when a desktop process has a different PATH.

`--capabilities` and `--version` are offline and do not spawn Codex. The package
exports `dsh-subagent-codex-pro/machine`; importing private source files is not a
supported integration.

## One request, one receipt

Write a single JSON document to stdin and close stdin:

```json
{
  "protocol": 1,
  "requestId": "task-42-attempt-1",
  "prompt": "Implement the approved task in this worktree and write its required report.",
  "cwd": "/absolute/path/to/task-worktree",
  "model": "gpt-6.1-sol",
  "effort": "high",
  "permissionMode": "workspace-write",
  "timeoutMs": 600000
}
```

```sh
npx --no-install codex-pro-machine --json < request.json > receipt.json
```

The required fields are protocol, requestId, prompt, cwd, model, effort and
permissionMode. Machine calls always name their model and permission explicitly.
Optional fields are command, timeoutMs, maxOutputBytes, threadMode, threadId,
images and outputSchema. Unknown fields fail before a process starts. The CLI
limits the entire request to 1 MiB. The runner limits stdout and diagnostic bytes
to 32 MiB by default; exceeding the configured positive maxOutputBytes stops the
run and sets execution.truncated instead of accepting a partial answer.

Permissions are read-only, workspace-write (approvalPolicy=never), or the
explicit dangerously-bypass-approvals-and-sandbox mode. The machine API does not
accept ambiguous legacy never/approve-for-me modes. Cwd is a directory, not proof
of a sandbox: inspect the complete returned sandboxPolicy, including writable
roots and network settings, against the caller's requirements.

The default thread is ephemeral. A resumed thread must be persistent; threadId
never silently changes to a new thread after failure. Execute and independent
review should use fresh calls. Orchestrators, rather than model conversation
history, own retries and durable task state.

The CLI prints exactly one JSON object on stdout. App-server diagnostics may go
to stderr. Exit 0 means a completed turn and confirmed cleanup; exit 1 means a
failed run or a consumer that closed stdout; exit 2 an invalid input envelope.
130/143 can accompany the result-shaped cancellation receipt when a signal is
observed during the run, or the `type: error` envelope when the signal arrives
before a request/run exists (for example while reading stdin). Inspect the
envelope; do not infer success from a text message or exit code alone.

## JavaScript API

```js
import { runMachine } from 'dsh-subagent-codex-pro/machine'

const controller = new AbortController()
const receipt = await runMachine(request, { signal: controller.signal })
if (!receipt.ok) {
  // Preserve the receipt and report failure to the owning orchestrator.
}
```

`parseMachineRequest` validates untrusted input. `runMachine` rejects invalid
input with MachineInputError; valid attempts return a receipt even when startup,
authentication, configuration, cancellation or cleanup fails. Options may supply
a trusted env override and onProgress callback; environment values and prompts
are never copied into the receipt's requested-configuration fields.

## Receipt contract

The envelope contains protocol=1, type=result, caller requestId, a per-attempt
runId, ok, requested, outcome or failure, costUSD=null and costStatus=unknown.
An invalid CLI input instead produces type=error with INVALID_REQUEST/INPUT_ERROR
and exit 2. It is not a started run.

| Field | Meaning |
|---|---|
| outcome.output / structured | Unmodified model text and separately validated JSON; no persistent-thread marker appended |
| outcome.configuration | requested/effective, source, missing fields, mismatches, matched and full observed sandboxPolicy |
| outcome.turnConfiguration | Requested effort and whether turn/start accepted it; effectiveEffort stays null because the protocol does not echo it |
| outcome.execution | run/thread/turn IDs, timestamps, elapsed duration, direct-child/driver pid (the installed Codex launcher may have a native server child), mirrored exit/signal, supervisor facts, timeout/cancel/truncation/spawn/failure facts |
| outcome.approvalDiagnostic | Bounded package-generated unattended approval/sandbox note; never raw server output or task text |
| outcome.cleanup | Confirmation of the owned process range's disappearance, with a reason when unconfirmed |
| outcome.usage | complete/partial/unknown; attributable run delta and thread totals, never summed cumulative snapshots |
| outcome.rateLimits | Account limits, separate from token usage and cost |
| failure | Startup stage/category plus available execution/configuration/usage/cleanup observations |

Missing observations remain null/unknown. A malformed usage event, counter
rollback or uncertain baseline prevents a complete usage claim. Subscription
authentication does not establish a dollar price or unlimited quota.

## Cancellation and process ownership

On POSIX the caller starts a guardian as a new process-group leader with an IPC
lifeline established during spawn. Codex and its ordinary descendants share
that group; they do not inherit the lifeline. The live caller owns normal
cleanup and checks that the group is gone. A live caller's SIGTERM/SIGINT stops
the guardian as soon as the app-server exits, so clean runs do not wait out the
full dispose grace. If the caller dies, including SIGKILL, IPC disconnect makes
the guardian retain the full grace and terminate its own group. There is no
later PID-registration window, name-based kill or ancestor-group kill.

The receipt distinguishes the direct child/driver process from its supervisor.
The installed Codex launcher may spawn the native app-server as its own child;
the reported exit/signal are mirrored launcher facts, not a claim that the
native server is the same PID. A successful turn may be followed by an
intentional TERM/KILL to close a long-lived app-server. execution.terminationRequested records that cleanup action; it is
not a caller cancellation. If the last escalation prevents an actual Codex exit
message from arriving, its exitCode/signal remain null even if the group is gone.
No supervisor exit is rewritten as a Codex exit 0. An unconfirmed cleanup cannot
produce a successful outcome, and DSH dispose rejects it.

If the caller cannot signal or confirm its group, it releases its own pipes and
IPC lifeline after the cleanup deadline so a failed run does not keep the caller
alive indefinitely. The guardian can then attempt its independent cleanup. The
receipt retains cleanup.confirmed=false and unknown process facts; that later
attempt is not evidence that the original cleanup succeeded.

A signal error also does not invalidate a later independent absence check.
Darwin can return EPERM while a group still exists but its members are being
reaped; the [XNU implementation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sig.c#L1675-L1721)
filters zombie members. EPERM remains unknown and is retried within the same
cleanup budget. Only a later ESRCH confirms the owned group is gone.

Machine execution requires POSIX and rejects Windows before spawning Codex;
capabilities reports supported=false there. Processes that deliberately escape
with a new session/group require a stronger external containment boundary. The
legacy Windows Host adapter controls a direct process and reports owned-process;
it must not be advertised as the POSIX group guarantee. A killed caller cannot
write a final receipt: its outer owner must record interruption, not success.

## DSH and Flywheel compatibility

The DSH adapter follows the rc.5 Host result contract: output, structured,
diagnostic and stopReason. Its diagnostic is bounded metadata, not raw server
output. Host capabilities are agentOptions, agentPreset=false, outputSchema and
depthLimit=false. Unsupported provider/maxTokens overrides fail explicitly.
Host job results remain strings. These narrow Host shapes do not carry the full
machine receipt; use this public entry when that receipt is required.

DSH Mac rc.5's SDK has no external-subagent/start RPC. Host startActivation needs
a real live parent Agent. An orchestrator should call this machine entry instead
of inventing a parent or treating codex-pro as a DSH LLM provider.

Flywheel 0.27.3 does not yet consume this API. A downstream consumer must add a
separate driver, pass the worktree/model/effort/permission/deadline/request ID,
validate the receipt and sandbox policy, preserve unknown usage and physical
facts, and retain Go ownership of reports, tests, retries, commits and budgets.
Changing a provider string alone does not implement that consumer.

## Verification and source baselines

The default tests are offline and use real scripted child processes. CI covers
Ubuntu/macOS with Node 22/24, then installs an actual npm tarball and tests the
public export, installed CLI and compiled guardian. Live model tests require
CODEX_SUBAGENT_LIVE=1. The 0.8.0 live app-server cases pass on Codex 0.165.0;
this is not a claim that the user's DSH Desktop profile has loaded the package.

- [DSH rc.5 Host types](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/subagent/subagent/src/types.ts)
- [DSH rc.5 SDK requests](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/sdk/protocol/src/types.ts)
- [Codex 0.166 ThreadStartResponse](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartResponse.ts)
- [Codex 0.166 TurnStartResponse](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartResponse.ts)
- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)

# Native Codex capabilities (0.10.0 source candidate)

Protocol 1 keeps its existing behavior when `native` is absent. A caller can now
opt into a versioned native policy. The adapter still starts the user's installed,
logged-in Codex app-server; it does not create a new account, billing path, SDK
client, or DSH session. These controls apply to the public `/machine` API and CLI.

```js
import { runMachine, MACHINE_NATIVE_CAPABILITIES } from 'dsh-subagent-codex-pro/machine'

const receipt = await runMachine({
  protocol: 1, requestId: 'implementation-1', cwd: '/repo/worktree',
  prompt: 'Implement the change. Delegate independent work when useful.',
  model: 'your-installed-codex-model', effort: 'high',
  permissionMode: 'workspace-write', threadMode: 'persistent',
  native: {
    version: 1,
    agents: {
      enabled: true,
      maxConcurrentThreads: 4,
      defaultModel: 'your-worker-model',
      defaultEffort: 'high',
      // Optional: explicitly select the current V2 collaboration backend.
      backend: 'v2',
    },
  },
}, {
  recoveryDirectory: '/repo/run-evidence/implementation-1',
  onLifecycle: async event => { /* durably save before resolving */ },
  onNativeEvent: event => { /* bounded metadata for the host's activity view */ },
})
```

## Configuration and full agent access

Native agents receive Codex's actual configured tools, permissions, MCP servers,
and model behavior. This package does not replace their tools with a read-only
helper subset. The caller selects the root sandbox explicitly; native agents
inherit the native harness's rules. Agent role definitions already installed in
Codex remain available. `defaultModel`/`defaultEffort` are defaults, not model
allowlists: a native spawn may select a different allowed model.

`maxConcurrentThreads` is a cap on open spawned threads, not a cumulative spawn,
token, or cost budget. V2's internal setting includes the root, so explicit V2
uses `N + 1`. With backend omitted, native/model backend selection remains intact;
an inherited V2 cap that exceeds the requested cap causes a configuration failure.
There is no claim that turning the V2 feature flag off forces a model to use V1.

Explicit off is `{version:1, agents:{enabled:false}}`. A present `native` with no
`agents` also disables agent dispatch. Off sets **both** `agents.enabled=false`
and `features.multi_agent_v2=false`; the V2 flag otherwise takes precedence.
Invalid/unknown controls fail before a process starts. The adapter passes config
overrides as separate argv values and checks `config/read` in the requested cwd
before it starts or resumes a thread. Missing, overridden or conflicting config
does not authorize a model turn. A config match proves configured values; observed
child/model events remain separate from requested defaults.

## Independent native review

```js
const review = await runMachine({
  protocol: 1, requestId: 'review-1', cwd: '/repo/reviewer-worktree',
  prompt: 'Native review operation', model: 'your-review-model', effort: 'high',
  permissionMode: 'read-only',
  native: { version: 1, review: { target: { type: 'baseBranch', branch: 'main' } } },
})
```

Targets are `uncommittedChanges`, `baseBranch` with `branch`, `commit` with `sha`
and optional `title`, and `custom` with `instructions`. The operation creates a
fresh thread, verifies its cwd/model/sandbox, then calls `review/start` with inline
delivery on **that new thread**. Executor history is never resumed or forked.
The operation's native target supplies the review instructions; the compatibility
`prompt` field is not submitted as an ordinary turn. Requested model and effort
are scoped `review_model`/`model_reasoning_effort` config overrides, checked before
dispatch. The review response must identify the same new thread.

Codex's native review internally disables collaboration, image viewing and web
search. The API therefore rejects review combined with enabled native agents,
images, outputSchema, or an existing threadId. For a multi-agent review or a
schema-constrained verdict, start an independent normal query instead. A native
review result is supporting evidence; it is not automatically a host's approval
or a validated structured review decision.

## Media and structured output

The existing `images: ['/absolute/image.png']` and object-rooted `outputSchema`
remain supported for normal turns with or without native agents. They use native
`localImage` and `turn/start.outputSchema`; neither is a prompt-only convention.
The result keeps text, structured output and returned image metadata in their
existing fields. Native observations do not alter the model's answer.

## Evidence, accounting and cancellation

`receipt.native` adds requested controls; config source/match/values; bounded
ordered observations; child identities/parents/models/states; per-child usage;
and independent cleanup facts. `onNativeEvent` receives the same metadata. It is
an advisory callback and cannot authorize dispatch or replace lifecycle ACKs.
The terminal native receipt is persisted with the existing private machine
journal, including when the caller disconnects. Recovery reads the original
receipt and never resumes a model on its own.

Only native parent relations, collaboration items and sub-agent activity items
establish ownership. Foreign-thread text/usage cannot become a child result or
root completion. Child approval requests are handled by the same unattended
approval policy, and only for a known child turn. Unknown requests do not receive
an expanded permission grant.

`native.usage.strategy` is `per-thread`, and its `scope` is `observed-children`.
`totalTokens` covers those children only; root usage remains in `outcome.usage`.
Counters are cumulative snapshots, not increments. Duplicate snapshots do not
increase spend; a resumed child adopts a historical baseline. Unknown baselines,
counter anomalies, missing observations or a truncated ledger make aggregation
partial/unknown. No observed children is unknown, not fabricated zero. The host
must not add a child snapshot more than once or confuse complete observed-child
usage with proof that all possible external spend was measured.

Late completions and replayed starts for an older child turn cannot replace the
active turn's identity. Native `failed` turns are terminal, while failure and
business success remain separate facts; a parent may handle a child failure.

Cancellation sends `turn/interrupt` to known running children and the root, then
uses the existing guardian's bounded process-group cleanup. A root interrupt by
itself does not prove all children stopped. `native.cleanup.confirmed` is set from
physical cleanup evidence, not an interrupt response or child completion text.
Permissions, thread state and configuration must be revalidated on every explicit
resume. No automatic retry occurs after a possibly dispatched failure.

## Verification and primary references

Offline tests exercise actual child processes for config mismatch before dispatch,
early child events, child approvals, deduplicated/replayed usage, cancellation,
fresh native review, supervisor delivery and the built installed npm package.
The package remains a source candidate until separately published. This change
does not claim an authenticated live-model/desktop acceptance run. A zero-model
probe of the installed `codex-cli 0.167.0-alpha.4` could read CLI help but timed out
at the configuration handshake in this environment; no model turn was sent.

Implementation contracts were checked against OpenAI's fixed source
[`7924f95421a326bb66426a3ce232b72550948470`](https://github.com/openai/codex/tree/7924f95421a326bb66426a3ce232b72550948470):

- [Native config schema](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/core/config.schema.json)
- [Backend precedence and caps](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/core/src/config/mod.rs)
- [Typed child items](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts)
- [Review endpoint](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/app-server-protocol/schema/typescript/v2/ReviewStartParams.ts)
- [Native review restrictions](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/core/src/tasks/review.rs)

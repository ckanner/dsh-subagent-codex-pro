# Native Codex capabilities (0.10.0 source candidate)

Protocol 1 keeps its existing behavior when `native` is absent. A caller can now
opt into a versioned native policy. The adapter still starts the user's installed,
logged-in Codex app-server; it does not create a new account, billing path, SDK
client, or DSH session. These controls apply to the public `/machine` API and CLI,
and are now also connected to the DSH plugin settings and tools described below.

English | [中文](native-capabilities.zh.md)

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

## Desktop settings and PTC tools

Open the installed bundle's `codex-pro` row configuration in DSH's Plugins page.
The shipped browser entry registers `plugins.row.config` using the Host's shared
React module. It edits only the `native` path through the owner form's atomic
`mutate(ops, expectedRevision)`, never a deep merge of stale enabled controls.
“Inherit configuration” unsets that path; “All off” writes `null`. The effective
value preview distinguishes inherited configuration from the editable override.
Read-only/unavailable forms cannot save; conflicts retain the draft and its
original revision until the user reloads.

The plugin exports an actual Schemastery `Config`. Its `native` field is
volatile and read once at each delegation's start, including the Host provider
path. Omission has no empty-object default. Other plugin configuration keeps its
existing remount semantics. YAML configuration remains available:

```yaml
native:
  version: 1
  agents:
    enabled: true
    maxConcurrentThreads: 3
    defaultModel: your-worker-model
    defaultEffort: high
    backend: v2
```

`subagent_codex({description, prompt, native, ...})` is the same registered tool
in ordinary DSH execution and in the automatically generated PTC tool SDK.
Omitting `native` inherits the current plugin default; no plugin default leaves
CLI-native defaults alone. A supplied object replaces that default completely.
Desktop `native:null` is shorthand for
`{version:1,agents:{enabled:false}}`; the public protocol-1 machine API still
uses the versioned object and does not accept this desktop shorthand.

A disabled policy may not carry enabled-only fields. Unknown native fields and
unknown tool arguments are rejected even if a caller bypasses JSON Schema.
When `modelSelection:false`, inherited child model/effort settings remain valid.
An enabled per-call object must keep those two values exactly, including
omission; replacing an object must not silently clear a configured model.
Explicit off is still permitted. Native fields do not expand the root sandbox.

An implicit `threadMode:session` resume is bound to native policy, model,
effort, permission and cwd. A binding change starts a new thread. Explicit
`thread_id` remains supported, including externally created threads: requested
configuration is reapplied and checked on every resume; a failed explicit
resume is reported, never silently replaced.

The latest DSH Host `SubagentStartRequest` has model/effort `agentOptions`,
but no generic provider-options or native field. Its provider path therefore
uses this plugin's live native default, while per-call native changes use
`subagent_codex` or `/machine`. Unknown Host start/options fields are rejected.
This is not a second Host Agent tree: Codex's children retain their native
lifecycle, permission, tool and usage semantics.

## Desktop native review

```js
await tools.subagent_codex_review({
  description: "Review branch changes",
  target: { type: "baseBranch", branch: "main" },
  // Optional when model selection is enabled:
  model: "your-review-model",
  reasoning_effort: "high",
})
```

This dedicated tool accepts description, target, cwd, timeout, model/effort when
authorized, and background execution when the jobs service exists. It fixes
fresh ephemeral execution, read-only sandbox, approvals=never, and agents off.
It does not accept prompt, native, thread controls, images or output_schema.
Review is rejected in plugin defaults and ordinary tool native overrides, so a
normal task cannot accidentally become review/start or lose its prompt.
For an agent-assisted review or structured verdict, use an ordinary independent
delegation with the appropriate prompt and schema.

## Desktop evidence

| Entry | Evidence and answer |
| --- | --- |
| Foreground / PTC tool | `{content,native}`; complete native receipt is separate from unchanged answer blocks. Rendering preserves image attachments and appends a bounded native metadata block. |
| Background job | With native evidence, `result` is a JSON string `{text,threadId,native}`; without it, the previous plain text result remains. Failed jobs retain an available native receipt. |
| Host provider | Official `output`/`structured` are unchanged. `diagnostic` and the plugin log retain bounded metadata: config match, completion/cleanup, pending counts and abbreviated ids, child state counts, usage scope/status and event truncation. |
| Machine API | Complete native receipt and existing durable recovery journal. |

The Host's narrow result contract is not extended with invented fields. Its
bounded summary is not the complete event ledger; callers needing all child
identities and events use the dedicated tools or machine API. An unconfirmed
native configuration, unfinished observed child or unconfirmed process cleanup
prevents a successful result, even when the root already emitted a final answer.

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
an expanded permission grant. A child `thread/started` received before the root
response is buffered with its nested thread identity; its ancestry is replayed
after the root becomes known before routing later child requests.

`native.usage.strategy` is `per-thread`, and its `scope` is `observed-children`.
`totalTokens` covers those children only; root usage remains in `outcome.usage`.
Counters are cumulative snapshots, not increments. Duplicate snapshots do not
increase spend; a resumed child adopts a historical baseline. Unknown baselines,
counter anomalies, missing observations or a truncated ledger make aggregation
partial/unknown. An unfinished child's last attributable snapshot remains
partial, including after physical cleanup; the snapshot is retained while the
complete aggregate total stays absent. No observed children is unknown, not
fabricated zero. The host
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

The desktop follow-up is validated by GitHub Actions against the actual npm
Schemastery package, registered plugin tools and real offline app-server child
processes. React component tests exercise saving, whole-value off/reset,
validation, read-only forms and revision conflicts. Package tests install the
real tarball into a clean consumer without DSH peers and exercise its public
machine API and installed CLI. Local execution was unavailable for this follow-up;
these checks do not claim an installed desktop or authenticated model run.

Earlier machine-capability offline tests exercise actual child processes for config mismatch before dispatch,
early child events, child approvals, deduplicated/replayed usage, cancellation,
fresh native review, supervisor delivery and the built installed npm package.
The package remains a source candidate until separately published. This change
does not claim an authenticated live-model/desktop acceptance run. During the earlier machine-capability review, a zero-model probe of
`codex-cli 0.167.0-alpha.4` could read CLI help but timed out at the configuration
handshake. That historical probe is not a new desktop follow-up execution; no
model turn was sent.

Implementation contracts were checked against OpenAI's fixed source
[`7924f95421a326bb66426a3ce232b72550948470`](https://github.com/openai/codex/tree/7924f95421a326bb66426a3ce232b72550948470):

- [Native config schema](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/core/config.schema.json)
- [Backend precedence and caps](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/core/src/config/mod.rs)
- [Typed child items](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts)
- [Review endpoint](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/app-server-protocol/schema/typescript/v2/ReviewStartParams.ts)
- [Native review restrictions](https://github.com/openai/codex/blob/7924f95421a326bb66426a3ce232b72550948470/codex-rs/core/src/tasks/review.rs)

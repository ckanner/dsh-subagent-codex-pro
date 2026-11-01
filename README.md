# dsh-subagent-codex-pro

English | [中文](docs/README.zh.md)

A Codex delegation tool that can carry **a model and a reasoning effort per
call** — the two things `@deepseek-ai/dsh-subagent-codex` cannot express.

```
tools.subagent_codex({
  description: "Probe output PROBE_OK",
  prompt: "Output exactly one line of text: PROBE_OK",
  model: "gpt-6-astra",
  reasoning_effort: "xhigh",
})
```

## The gap this fills

`subagent_codex`'s schema exposes only `description` and `prompt`, so a caller
cannot name a model or a thinking level. In a recorded session a model asked to
do exactly that tried the obvious thing and was refused:

```
ToolCallError: child model selection is disabled for this tool instance
```

The chain, from the harness source:

```
tool schema exposes model / reasoning_effort
  ← only when modelSelectionEnabled
modelSelectionEnabled ← modelSelectionSettings: true on the tool row
modelSelectionSettings: true ← requires a provider declaring `agentOptions`
@deepseek-ai/dsh-subagent-codex ← declares NO_START_CAPABILITIES (no agentOptions)
                                → enabling it throws while the preset mounts
```

The Codex protocol supports the choices this package exposes: `model` and the
unattended permission policy on `thread/start`, model/cwd/permission overrides on
`thread/resume` (0.165+), and `effort` per turn on `turn/start`. The official
provider never sends them. Reported upstream:
<https://github.com/deepseek-ai/deepseek-harness/discussions/9115>

There is a second, separate defect: enabling `modelSelectionSettings: true` on a
row whose provider is external (`codex-pro`) makes that row **silently**
register no tool at all — no error, no log, no failed-preset badge. A control row
identical except for the flag registers normally. Also in that report.

## How this works instead

Two layers, both under this package's control.

### Execution: the same protocol the official provider speaks

`src/wire.ts` and `src/run.ts` are a port of the official app-server adapter —
the initialize handshake, the ephemeral thread, thread/turn association
including notifications that arrive before `turn/start` returns, unattended
approval decisions, and terminal-answer selection by phase — with these
additions:

```js
// thread/start
{ cwd, ephemeral, ...(model ? { model } : {}), ...THREAD_PERMISSION_PARAMS[mode] }
// thread/resume (0.165+)
{ threadId, cwd, ...(model ? { model } : {}), ...THREAD_PERMISSION_PARAMS[mode] }
// turn/start
{ threadId, input: [...], effort, ...(outputSchema ? { outputSchema } : {}) }
```

Neither literal appears anywhere in the official adapter's 871 lines. A thinking
level is a `turn/start` field, not a `thread/start` field in 0.165/0.166; the
thread-time default is left to Codex. Two
mechanical differences from the source: the JSON-RPC transport is this package's
own (`src/jsonrpc.ts`), and the app-server is started as
`<command> app-server --stdio` from `PATH` rather than from `@openai/codex`'s
manifest. `src/codex-exec.ts`, the earlier `codex exec` path, is retained and
tested but unused.

The executable is the `command` setting (default `codex`), resolved through the
Host's `PATH` — and the desktop app captures that environment when it launches.
A Node version switch, or any change to the login shell, can leave the global
install out of it. When that happens, set `command` to an absolute path: the
official `@deepseek-ai/dsh-subagent-codex` bundle ships a pinned executable
inside the profile (`node_modules/@openai/codex-darwin-arm64/vendor/<arch>/bin/codex`
on Apple silicon), so Codex Pro and the official provider can share one CLI
without depending on `PATH`.

### Tool registration: this plugin's own context

The plugin registers the delegation tool **itself**, on `agent/created`, into
that Agent's own context — the path `dsh-plugin-lcu` uses for its tools:

```ts
ctx.on('agent/created', ({ agent }) => { if (!presetAllows(agent)) return; serve(agent) })
ctx.on('agent-preset/selected', (sessionId, preset) => { … })
// serve(): agent.ctx.tools.register(createCodexTool({ … }))
```

That keeps the harness's preset-row machinery out of the path entirely. A preset
needs no rows of its own: `presets` names the committed Agent presets that get
the tool — `daily` and `heavy` here.

Because the tool name is fixed, the official `subagent_codex` must not also
serve those presets. As of DSH 0.2.1 the official
`@deepseek-ai/dsh-subagent-codex` bundle ships `tool-subagent-codex` as a
**global Host tool** (visible to every preset), so a profile cannot switch it
off by disabling a per-preset row. This plugin registers its tool into the
Agent's own scope on `agent/created`, and a scoped registration shadows the
global one for its Agents — the official README documents the same precedence.
Two registrations in *one* scope still collide: the later one throws and its
tool silently never appears, which is why a profile must not also enable a
same-name `tool-subagent` row beside this provider.

**Whatever the prompt names is what runs.** `model` and `reasoning_effort` are in
the schema, and an explicit choice in the call wins; when a delegation names
neither, the choice stays with Codex's own configuration (`~/.codex/config.toml`)
— the plugin is configured without defaults so that nothing silently overrides
either. `modelSelection: false` hides the two fields entirely.

The Host's `subagent-model-selection` setting is deliberately **not** consulted.
It authorizes a child **LLM route** chosen from the DSH catalog and billed as
tokens, while a Codex delegation names a **Codex model id** under the Codex CLI's
own subscription: different resources, different namespaces. That setting can
neither authorize nor constrain this choice, and reading it would only couple the
tool to a setting that has nothing to say about it.

## Install

```sh
# as a bundle in a DSH profile
dsh plugin --profile desktop add dsh-subagent-codex-pro
# or from a checkout, for development
dsh plugin --profile desktop add link:/path/to/dsh-subagent-codex-pro
```

## Verify

```sh
npm install
npm run typecheck
npm test                                  # offline suite; live cases skip
CODEX_SUBAGENT_LIVE=1 npm test            # extra real turn through the live Codex
npm run test:coverage                     # Node's built-in coverage report
```

The plugin logs every decision to `~/.dsh/codex-pro.log`:

```
apply: provider "codex-pro" registered with agentOptions: true; presets=["daily","heavy"]
decide … composed=standard header=standard -> skip
serve …: subagent_codex registered (modelSelection=true, background=true, via=app-server)
run: model=gpt-6-astra effort=xhigh cwd=… prompt=179B via=app-server
run: published 3f2a…
run done: text=8B thread=… images=0 usage=complete(312 tokens) cleanup=confirmed config=true
run config: requested={"cwd":"…","approvalPolicy":"never","sandbox":"read-only"} effective={"cwd":"…","approvalPolicy":"never","sandbox":"read-only"}
```

A verified end-to-end run: 30 s wall clock, the model's `PROBE_OK` returned as
the tool result. The live app-server test opens a thread and puts `effort` on the
turn; it does **not** claim a thread-level thinking level, which 0.165/0.166 do
not accept.

## Verification layers

This hardening distinguishes three layers rather than calling one of them
"verified" for all:

1. **Offline / hermetic** — the default `npm test` suite. It drives the real
   protocol classes and a real child process through a scripted fake app-server:
   startup hangs, turn hangs, caller cancel, early exit, resuming, usage replay,
   duplicates, read-only permissions, structured verification, process-group
   descendants, and idempotent teardown. No model is called and no Codex account
   is touched.
2. **Real Codex app-server** — the live app-server cases were run against the
   installed Codex **0.165.0** with `CODEX_SUBAGENT_LIVE=1`:
   `4/4` passed. They covered model + effort, the defaults, a persistent thread
   resumed with explicit model/cwd/read-only overrides (including usage replay
   and effective-config verification), and `output_schema` decoding. The
   separate `codex exec` live case also passed (`20/20` in that file, one real
   CLI call). The official **0.166.0** TypeScript schemas were reviewed for
   `ThreadResumeParams`, `ThreadResumeResponse`, `ThreadTokenUsage`, and
   `token_usage_replay.rs`, but no 0.166 runtime was executed. The plugin calls
   the same `codex app-server --stdio` path.
3. **Real DSH desktop end-to-end** — still not run. The implementation keeps
   the existing DSH provider/tool/job contracts; a desktop smoke test remains
   the one unexecuted layer. v0.7.0 is released through the repository's
   tag-driven workflow; the user's global Codex login/config was not modified.

## Making the answer machine-readable

`output_schema` hands Codex a JSON Schema its final answer must conform to, so a later step can read the
answer instead of parsing prose and hoping:

```js
tools.subagent_codex({
  description: "Smoke verdict",
  prompt: "Assess whether both endpoints returned 200.",
  output_schema: {
    type: "object",
    properties: { verdict: { type: "string", enum: ["pass", "fail"] }, count: { type: "number" } },
    required: ["verdict", "count"],
    additionalProperties: false,
  },
})
```

The schema must be object-rooted — the same rule the harness applies to a schema it passes a provider — because
Codex constrains a whole answer and a bare scalar has nowhere to put the shape. The app-server **enforces** it:
a measured run came back as `{"verdict":"pass","reason":"…","count":2}`, with no extra keys and every required
one present. The answer arrives as **text**, and that text is JSON.

It is sent on the turn, not the thread: the same field on `thread/start` is accepted and silently ignored — the
answer came back as prose. Measured both ways.

A provider the harness drives (`thread-subagent`) can also be given a schema by its row, and this plugin
declares that capability and verifies the answer before reporting `structured`. Verification is now
**fail-closed**: invalid JSON, a non-object answer, a required/type/range violation, or a schema keyword this
package cannot verify makes the run report an error/diagnostic instead of quietly omitting `structured`. The
validator covers the object-rooted JSON Schema subset this tool accepts and rejects unsupported keywords rather
than pretending they were checked.

For a call carrying `output_schema`, the answer stays exactly the JSON text Codex returned. The persistent
thread marker is **not** appended to machine-readable output; the thread id is reported separately and in the
diagnostic log. Plain human-text answers keep the marker that makes a thread continuable.

## Showing Codex a picture

`images` hands Codex pictures alongside the task, so it receives them as pictures instead of being told to go
and open a file:

```js
tools.subagent_codex({
  description: "Match this design",
  prompt: "Rebuild this screen's layout in the component below.",
  images: ["/tmp/design.png"],
})
```

Each path must be absolute, must exist, and must be a file; anything else fails the call before anything is
spawned. That check is not decoration: **the app-server silently ignores a `localImage` path that does not
exist** — measured, with the turn completing normally and no error item — so an unchecked typo would produce a
delegation that quietly lacks the picture the task was about.

The pictures are sent as the app-server's `localImage` variant, which is the one form it accepts without the
bytes travelling: its `image` variant wants an `ImageReference` this plugin cannot construct, and both
`{type:'image', data, mimeType}` and a `data:` URL are rejected outright. A host path needs no encoding.

Naming images does not disturb the thread: they belong to the turn, not to the thread, so a resumed thread can
be shown a new picture.

## Choosing the directory

A delegation runs in the session's working directory by default. `cwd` names another one:

```js
tools.subagent_codex({
  description: "Post-deploy UI smoke",
  prompt: "…",
  cwd: "/tmp/mesh-smoke/20261010-0800",
})
```

The path must be absolute, must exist, and must be a directory; anything else is refused with a message naming
the problem rather than a run that quietly happens somewhere unexpected. It is a working directory, not a
sandbox boundary — what a run may touch is the permission mode's decision.

**On 0.165, `thread/resume` accepts overrides, and this plugin actually sends them.** A resumed delegation
sends the requested `cwd`, `model` (when one is chosen), and permission parameters, then compares the
`thread/resume` response's effective `cwd`, `model`, `approvalPolicy`, `approvalsReviewer`, and `sandbox`
with what was requested. A response that ignored an override is an error, not a silent fallback to the
thread's history. This replaces the 0.164-era behaviour where `cwd` beside a `thread_id` did not relocate the
thread: that is no longer the protocol this package targets.

For a **remembered** thread (`threadMode: session`, not an explicit `thread_id`), a resume that cannot apply
the current configuration is treated as incompatible reuse: the plugin logs it and starts a fresh thread,
under the same call deadline. For an **explicit** `thread_id`, the requested thread is the whole request, so an
incompatible or refused resume is reported; it is never silently replaced by a different thread.

`reasoning_effort` remains a per-turn `turn/start` setting and still applies when the thread is resumed. The
thread's historical default thinking level is visible in the resume response but is not restated by this
package.

## Images

Codex can look at pictures and can take screenshots; this tool can now hand those pictures back.

**What arrives.** The app-server reports an image two ways, and both are captured. `imageView` names a **file on
this host** — the bytes are never inlined, because the host that asked for the work is expected to read the file
itself, which is exactly what this plugin does. A computer-use screenshot instead arrives as an **image content
block** inside an MCP tool result, carrying its bytes.

**What is delivered.** The plugin reads the file (or decodes the block), hands the bytes to the harness's
attachment store, and returns image blocks alongside the text. The model then sees an image rather than a
description of one.

**What the model's route decides, and why the rule is deliberately loose.** An image is refused only when the
route **declares** input modalities and `image` is not among them — the harness's own rule, so that an
undeclared route is left to the harness rather than second-guessed here. `deepseek-flash`, the default, declares
`['text', 'image']`, so screenshots do arrive in an ordinary session.

An earlier guard failed closed whenever the route could not be resolved, which silently turned every image into
a text note in a session that could have displayed it. It does not any more: an unresolvable route delivers the
image. When a route really does refuse images the note reads
`[image not delivered: this model route declares no image input]`.

The same note covers every other failure — no attachment store, an unreadable file, a file over 20 MB, an
unsupported media type. **Nothing here can fail the delegation**; the answer the run produced always survives.

**A background call gets paths, not pictures.** A foreground delegation returns image blocks, so the model
sees the picture. A `run_in_background` delegation returns a job id, and everything read back through
`job_output` is text by contract — so its images are reported as paths in that text instead:
`[1 image: /Users/…/shot.png]`. The file is on this host either way. For a screenshot you want the model to
actually look at, delegate in the foreground.

**Sending pictures *in*.** The protocol accepts `input_image`, `local_image`, `image_url` and even audio, but this
tool currently sends text only. Until that changes, name the **path** in the prompt: Codex opens the file itself
with its own image tool, which is verified — asked to describe a screenshot by path, it read out the providers
listed on it.

## Overriding this row in a profile

The row this package declares is a bundle patch. A profile that wants different settings adds its own row with
the same `id`, and the loader **replaces the whole `config` map**: it walks the patch's top-level fields and
assigns each to the target, and `config` is one of those fields. It does not merge deeply, and it does not merge
arrays.

So every field has to be restated, or it is gone:

```yaml
# ✗ `presets` is gone, and with it the tool. The row still mounts — it just
#   matches no preset, so `subagent_codex` never appears in any session.
- id: codex-pro
  config:
    runTimeoutMs: 5400000

# ✓ the whole map, every field
- id: codex-pro
  name: 'dsh-subagent-codex-pro'
  config:
    providerName: codex-pro
    presets: [daily, heavy]
    runTimeoutMs: 5400000
```

This failure is quiet in the worst way. A patch whose `id` matches nothing, or whose `name` disagrees with the
target's, is **skipped with a warning** rather than an error; and a `config` that lost `presets` still mounts,
it simply serves no session. The `apply` line this plugin writes to `~/.dsh/codex-pro.log` names the presets it
actually received, which is where to look:

```
apply: v0.7.0 provider "codex-pro" registered … timeout=5400000ms; presets=["daily","heavy"]
                                                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^
```

## Thread lifetime

Every delegation used to open an ephemeral thread — the app-server deletes it when the connection ends, so
nothing was left to list or continue. `threadMode` chooses instead:

```yaml
- id: codex-pro
  config:
    threadMode: session       # ephemeral (default) | persistent | session
    runTimeoutMs: 600000      # deadline for one delegation; 0 disables it
```

A call may name its own `timeout_ms`, which overrides the configured default for that one delegation — `0`
meaning no deadline at all. That is what makes the deadline usable from a prompt: a release smoke test needs tens
of minutes, a quick lookup does not, and the model can say which this is because the value is a parameter rather
than a file.

**A delegation that hangs is otherwise invisible.** The job stays `running`, the session waits, and nothing is
logged — which is exactly what a stalled model request looks like from the outside. `runTimeoutMs` is the
deadline for one whole delegation, and it covers **startup too**: `initialize`, `thread/start`/`thread/resume`,
`thread/name/set`, and the turn all use one derived abort signal. When it passes, the run is cancelled, its
process range is torn down under a separate bounded grace, and the result says
`codex-pro: the delegation exceeded its 600000 ms deadline and was cancelled` instead of nothing at all. The
default is ten minutes, generous against a task class whose own documentation says "a minute or more"; `0`
restores the old behaviour of waiting forever.

The timeout, a caller cancellation, a protocol failure, and an unexpected process exit are distinct failure
categories. Settlement happens once; teardown is idempotent. A failed resume that is being repaired by a fresh
thread shares the original absolute deadline, so the retry cannot borrow a second full timeout.

**Cleanup is proven, not assumed.** On POSIX the app-server is the leader of its own process group. Teardown
sends `SIGTERM` to the whole group, waits the configured grace (`disposeGraceMs`, default 3 s), then `SIGKILL`
and polls until the group is gone. A descendant that outlives its parent is reported as
`cleanup: { confirmed: false, detail: … }` rather than treated as cleaned; the custom tool turns an
unconfirmed cleanup into an explicit failure. There is no global `killall codex`. On Windows the direct child is
managed; process-range confirmation is a POSIX guarantee.

| | |
|---|---|
| `ephemeral` | A throwaway run. Nothing is written that the Codex CLI or the Codex application can list. |
| `persistent` | Every delegation gets a durable thread: written to `~/.codex/sessions/`, listed by both, continuable. |
| `session` | One durable thread per Agent session, so ten delegations leave one thread and every call after the first continues the same conversation. |

A call overrides the choice with `thread_mode`, and continues a thread of its own with `thread_id`. A persistent
human-text result ends with the thread's id; a schema-constrained result stays pure JSON and reports the id
separately:

```
[codex thread 01a1212b-79cf-7241-8892-896094fad3d6 · persistent · pass it as thread_id to continue]
```

Resuming **does not ignore the caller's choices on 0.165**: `model`, `cwd`, and `permission_mode` are sent as
`thread/resume` overrides and compared against the response. `reasoning_effort` is a per-turn setting and still
applies. A remembered thread with an incompatible configuration is replaced by a fresh thread; an explicit
`thread_id` reports the incompatibility instead of continuing somewhere else. Machine-readable JSON does not
get the thread marker described next.

**Two things the app-server decides, both measured.** A thread with no turn yet is not resumable — it answers
`no rollout found` — so a thread becomes continuable only after its first completed turn. And the Codex
application lists a thread only when its originator is exactly `Codex Desktop`, the single value its client
filters on; `originator` sets that and defaults to the literal. Overriding it trades application visibility for
an honest name, and the Codex CLI lists the thread either way.

Because the originator cannot say where a thread came from, a persistent one is named
`DSH · <the call's description>` through `thread/name/set`, which is what a person sees in the list.

**One thread carries one turn at a time.** Two delegations sent at once from the same session would both reach
for the remembered thread, and the app-server refuses the second with `thread-store conflict: … already has an
active writer`. A session-mode call therefore checks before it starts: a remembered thread that another
delegation is using is skipped, the call gets a thread of its own, and the skip is logged. Parallel work still
runs — it simply stops sharing one conversation, which is what `persistent` does anyway, so the mode falls back
to the mode that supports the shape of the work. Pick `session` for sequential work that benefits from a
continuing conversation, and `persistent` or `ephemeral` when delegations run at the same time.

**Why it is worth more than convenience.** A resumed thread keeps the same prompt prefix, so the endpoint's
cache keeps hitting. Measured on the Codex side, 93–99% of input tokens came from cache; the same work driven
through a plan-usage route measured 0%, because that route refuses every cache control.

## Permissions, including read-only review

The permission mode is the plugin's unattended policy, not an approval prompt. The default is deliberately the
write-capable mode needed for implementation work; this change does not alter it globally.

| mode | Codex `approvalPolicy` | `sandbox` | use |
|---|---|---|---|
| `dangerously-bypass-approvals-and-sandbox` | `never` | `danger-full-access` | default implementation work |
| `approve-for-me` | `on-request` | `workspace-write` | agent runs write-capable work with a reviewer for approvals |
| `never` | `never` | omitted | no approval prompts, but **not read-only** |
| `read-only` | `never` | `read-only` | review/inspection that must not write or execute |

`approvalPolicy: 'never'` only means "do not ask a human"; it says nothing about the filesystem or execution
sandbox. A real read-only Review mode therefore needs `sandbox: 'read-only'`, which the new `read-only` mode
sends on both `thread/start` and `thread/resume`. The same modes are available as a per-call
`permission_mode`, so a caller can review read-only while leaving the configured default write mode alone.
The requested and effective permission facts are recorded in the run outcome and the diagnostic log; a
response that ignored them fails unpublished.

## Usage and rate limits

Codex reports `thread/tokenUsage/updated` with a thread-cumulative `total` and a last-model-call `last`. A
delegation can make several model calls, and `thread/resume` replays the latest persisted snapshot for the new
connection. Treating that replay as current spending is wrong.

The tracker folds notifications into one run report:

- `run` is the delta from the observed baseline, never a sum of notification snapshots.
- A pre-turn replay after resume becomes the baseline and contributes no run usage.
- A resume with no replay before its first live snapshot is `partial`; the report never invents a zero.
- Duplicate and out-of-order snapshots are ignored; a counter that moves backwards marks the report `partial`
  rather than producing negative usage.
- Usage from another thread/turn is not added.
- No observation is `unknown` with no `run`, never a fake `0`; an observation that arrived before a failure,
  timeout, or cancellation is retained in the failed outcome.
- `cachedInputTokens` is a subset of `inputTokens` and `reasoningOutputTokens` is a subset of `outputTokens`;
  the fields are reported as Codex states them and never added together.

`account/rateLimits/updated` is stored separately as `rateLimits`; account limits are not token usage and are
not merged into it. Both are exposed on `CodexRunOutcome` / `delegateOnce` results and written to the diagnostic
log. The DSH `SubagentResult` and tool-result contracts have no `usage`/`rateLimits` field, so the provider and
custom tool do not invent host fields; the tool result remains content-only, and the background job result
remains the contract's string. The diagnostic log is the host-visible surface for this information.

## Background runs and progress

A delegation takes a minute or more, so `run_in_background` exists whenever the
jobs service is loaded (`@deepseek-ai/dsh-jobs`). It returns a job id:

```js
tools.subagent_codex({ description: "…", prompt: "…", run_in_background: true })
// → { kind: "background", jobId: "subagent-3" }   collect with job_output
```

The child's own activity is appended to the job's output ring as it happens —
completed commands and file changes, plus Codex's `commentary` messages — so
`job_output` shows how a long delegation is going, not only what it finally said.

## Capabilities

| | status |
|---|---|
| `model` / `reasoning_effort` per call | ✅ |
| final message returned | ✅ |
| images the run produced (screenshots, viewed files) | ✅ when the calling model route accepts images |
| images handed to the run (`images`, absolute paths) | ✅ |
| schema-enforced answer (`output_schema`, or the harness's row setting) | ✅ verified locally |
| `run_in_background` + progress via `job_output` | ✅ |
| read-only review permission (`read-only`) | ✅ `approvalPolicy=never` + `sandbox=read-only` |
| token usage / model context window | ✅ internal outcome + diagnostic log; DSH result/tool/job contracts carry no usage field |
| account rate limits | ✅ separate from token usage; internal/log only |
| process-range cleanup with confirmation | ✅ POSIX; unconfirmed is reported |
| deadline covers startup and turn; user cancel distinct | ✅ |
| app-server protocol (handshake, thread lifecycle, approval decisions) | ✅ |
| interactive approvals | by design none — a delegated run is unattended, as the official provider is |
| continuable / thread reuse | ✅ `session` reuses one; `thread_id` continues any |
| `maxDepth` / persona / `toolFilter` | ❌ not applicable — see below |

The three refusals above are not gaps to be filled. A Codex delegation is a **leaf**: it has no DSH child
agent, so a delegation-depth cap has nothing to cap. Its tools are Codex's own — the shell, the patch tool, its
own MCP servers — not this harness's, so a **tool filter**, which names DSH tools, cannot describe them; restrict
Codex through its own configuration instead. And a **persona** is a system instruction for a child agent, where
this one already takes the task in `prompt`. Declaring any of them `true` would promise the harness an
enforcement that does not exist.

The official provider remains the better choice where protocol fidelity matters.
This exists because it cannot express these two choices, and should be retired
once upstream can.

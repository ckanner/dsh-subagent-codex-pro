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

The Codex protocol supports both fields (`ThreadStartParams.reasoningEffort`,
`TurnStartParams.effort`); the official provider never sends them. Reported
upstream: <https://github.com/deepseek-ai/deepseek-harness/discussions/9115>

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
approval decisions, and terminal-answer selection by phase — with exactly two
additions:

```js
// thread/start
{ cwd, ephemeral, ...(model ? { model } : {}), reasoningEffort, ...THREAD_PERMISSION_PARAMS[mode] }
// turn/start
{ threadId, input: [...], effort }
```

Neither literal appears anywhere in the official adapter's 871 lines. Two
mechanical differences from the source: the JSON-RPC transport is this package's
own (`src/jsonrpc.ts`), and the app-server is started as
`<command> app-server --stdio` from `PATH` rather than from `@openai/codex`'s
manifest. `src/codex-exec.ts`, the earlier `codex exec` path, is retained and
tested but unused.

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

Because the tool name is fixed, the official `tool-subagent-codex` row is
**disabled** in those presets. Two rows registering the same tool name in one
Agent's scope collide: the second registration throws and its tool silently never
appears.

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
npm test                                  # argv + tool-schema cases; live case skipped
CODEX_SUBAGENT_LIVE=1 npm test            # also runs gpt-6-astra + xhigh for real
```

The plugin logs every decision to `~/.dsh/codex-pro.log`:

```
apply: provider "codex-pro" registered with agentOptions: true; presets=["daily","heavy"]
decide … composed=standard header=standard -> skip
serve …: subagent_codex registered (modelSelection=true, background=true, via=app-server)
run: model=gpt-6-astra effort=xhigh cwd=… prompt=179B via=app-server
run: published 3f2a…
run done: text=8B
```

A verified end-to-end run: 30 s wall clock, the model's `PROBE_OK` returned as
the tool result. A real app-server run is also covered by the live test, which
opens a thread with `reasoningEffort` and a turn with `effort`.

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

## Thread lifetime

Every delegation used to open an ephemeral thread — the app-server deletes it when the connection ends, so
nothing was left to list or continue. `threadMode` chooses instead:

```yaml
- id: codex-pro
  config:
    threadMode: session       # ephemeral (default) | persistent | session
```

| | |
|---|---|
| `ephemeral` | A throwaway run. Nothing is written that the Codex CLI or the Codex application can list. |
| `persistent` | Every delegation gets a durable thread: written to `~/.codex/sessions/`, listed by both, continuable. |
| `session` | One durable thread per Agent session, so ten delegations leave one thread and every call after the first continues the same conversation. |

A call overrides the choice with `thread_mode`, and continues a thread of its own with `thread_id`. A persistent
result ends with the thread's id:

```
[codex thread 01a1212b-79cf-7241-8892-896094fad3d6 · persistent · pass it as thread_id to continue]
```

Resuming ignores `model` and `reasoning_effort`: both are `thread/start` parameters, and a resumed thread keeps
the ones it was created with. The per-turn `effort` still applies.

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
| `run_in_background` + progress via `job_output` | ✅ |
| app-server protocol (handshake, thread lifecycle, approval decisions) | ✅ |
| interactive approvals | by design none — a delegated run is unattended, as the official provider is |
| continuable / thread reuse | ✅ `session` reuses one; `thread_id` continues any |
| depth limit, persona, outputSchema, toolFilter | ❌ not implemented |

The official provider remains the better choice where protocol fidelity matters.
This exists because it cannot express these two choices, and should be retired
once upstream can.

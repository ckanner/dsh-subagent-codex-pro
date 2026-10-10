# Changelog

## 0.4.0

A delegation can run in a directory of its own.

`cwd` names an absolute path the run should use instead of the session's working directory — the shape a
post-deploy smoke test needs, where the run may write its artifacts but the repository must stay clean.

The path must be absolute, must exist, and must be a directory; anything else is refused with a message naming
the problem, rather than a run that quietly happens somewhere unexpected. It is a working directory and not a
sandbox boundary: what a run may touch remains the permission mode's decision.

Naming a directory also starts a fresh Codex thread, because a thread belongs to the directory it was created
in — continuing one elsewhere would be continuing a conversation about different files. `cwd` is therefore
incompatible with `threadMode: session`'s reuse, and the log says which directory each run used.

Requested while retiring a skill whose two jobs this plugin now covers: dispatching to Codex, and getting
screenshots back — which the skill could not do, and which is why its instructions required artifacts to land on
disk instead.

## 0.3.3


A delegation now has a deadline, because one without it is invisible when it stalls.

`runTimeoutMs` bounds one whole delegation, defaulting to ten minutes and disabled by `0`. When the deadline
passes, the run is cancelled, the child process is torn down, and the result carries
`codex-pro: the delegation exceeded its 600000 ms deadline and was cancelled` rather than nothing at all.

The harness's own vocabulary has no `timeout` stop reason, so the provider path reports a cancelled run as
`aborted` while the diagnostic carries the reason; this plugin's own tool reports `timeout` and formats the
message itself.

Found in a real session: a screenshot delegation had been running for seven minutes at 0% CPU with one
established connection to a local proxy, no rollout written, and nothing anywhere in the log to say so. The
proxy turned out to be healthy — the stall was in the streaming request — which is precisely why the deadline
matters more than the diagnosis: whatever the cause, the wait now ends with a reason.

Verified live: a three-second deadline cancelled a run at 3.1 s, returned the diagnostic, and left no child
process behind.

## 0.3.2


A background delegation no longer loses its images.

`run_in_background` returns a job id, and everything read back through `job_output` is text by contract, so the
image blocks a foreground call returns were simply dropped — silently, and with no trace of where the picture
went. A screenshot taken by a background delegation is still a file on this host, so the text now names it:
`[1 image: /Users/…/shot.png]`. A foreground call is unchanged and still delivers the image itself; `render` no
longer repeats the count, because the text already carries it.

Found by looking at a real session rather than at the code: a screenshot delegation had been started in the
background, and there was no path in the answer it would eventually produce.

## 0.3.1


The image guard was too strict, and it would have hidden the feature it was added for.

0.3.0 refused an image whenever the calling route did not **report** `image` among its input modalities, and it
failed closed: a route it could not resolve was treated as a route that cannot take images. The default
`deepseek-flash` entry declares `['text', 'image']`, so a session that could display screenshots would instead
have been told `[image not delivered: …]` for every one of them.

The rule is now the harness's own — an image is refused only when the route **declares** modalities and `image`
is not among them — and an unresolvable route delivers the image rather than withholding it. The route lookup
also gained the fallback `dsh-plugin-lcu` uses, so a session header without a model still resolves.

The rule is a pure function, `routeRefusesImages`, so the boundary is covered by tests instead of by whichever
session happens to be running.

## 0.3.0


Images a delegation produces now come back.

The app-server reports them two ways and both are captured. `imageView` names a file on this host — the bytes
are never inlined, because the host that asked for the work is expected to read the file itself — while a
computer-use screenshot arrives as an image content block inside an MCP tool result. The plugin reads or decodes
whichever it gets, hands the bytes to the harness's attachment store, and returns image blocks beside the text,
so the model sees a picture instead of a description of one.

An image is only delivered when the calling Agent's model route reports `image` among its input modalities, the
same guard `dsh-plugin-lcu` applies to its screenshots. Everything else — no store, an unreadable file, over
20 MB, an unsupported type, a route that cannot take images — becomes a text note. None of it can fail the
delegation: the answer the run produced always survives.

Verified against a real app-server through this package's own code: asked to open a file by path, Codex read the
providers listed on the screenshot aloud, and the run reported one captured image with its host path.

Sending images *in* is not implemented. The protocol accepts `input_image`, `local_image`, `image_url` and
audio, but this tool still sends text only; naming a path in the prompt remains the working route, and both
READMEs now document what each side actually supports.

## 0.2.2


**`session` mode no longer collides with itself.** A thread carries one turn at a time, so two delegations sent
together from one session both reached for the remembered thread and the app-server refused the second with
`thread-store conflict: … already has an active writer`. The plugin now tracks which threads its Agent is
delegating in and checks before it starts: a remembered thread in use is skipped, the call gets a thread of its
own, and the skip is logged. Parallel work keeps running, and the mode falls back to `persistent` — which is
what that shape of work needs anyway — instead of failing and retrying.

The decision is a pure function, `chooseThread`, so it is covered by tests rather than by an app-server. An id
the caller passed explicitly is never skipped: continuing that thread was the request, and running somewhere
else would answer a different question.

## 0.2.1


`apply` now records the thread mode and the originator, so the log says which lifetime is in force without
anyone reading the profile to find out.

**The session-mode retry is narrowed to the failure it was meant for.** It wrapped every delegation, so a turn
that failed for its own reasons was retried as a fresh thread — paying for the same work twice and hiding the
real failure behind a second attempt. It now applies only to a resume the app-server refused.

**A concurrency limit, measured rather than assumed.** Two delegations sent at once to one thread collide: the
app-server answers `thread-store conflict: … already has an active writer` and the second fails, while
`ephemeral` runs the same pair independently. `session` is therefore the wrong mode for parallel work, and both
READMEs now say so.

## 0.2.0


A delegation can now outlive its run.

**Thread lifetime is a choice, not a constant.** Every delegation used to open an ephemeral thread, which the
app-server deletes when the connection ends — nothing to list, nothing to continue. `threadMode` now has three
settings: `ephemeral` keeps that behaviour and stays the default; `persistent` gives each delegation a durable
thread; `session` reuses one durable thread for the whole Agent session, so ten delegations leave one thread
rather than ten and each call after the first continues the same conversation.

**A durable thread is one the Codex CLI and the Codex application can see.** Verified against a real
app-server: the thread is written to `~/.codex/sessions/`, appears in `thread/list`, and can be continued with
`thread/resume`. The application's own list is the narrow part — its client filters by a single hardcoded
originator value, `Codex Desktop`, so `originator` exists to set that and defaults to the value that works.
Overriding it trades application visibility for an honest name; the CLI lists the thread either way.

**Threads are named, because the originator cannot say where they came from.** A thread from this provider has
to claim to be `Codex Desktop` to be listed at all, so `thread/name/set` carries the identification instead:
a persistent thread is named `DSH · <the call's description>`, which is what a person sees in the list.

**The model can control it per call.** The tool gained `thread_mode` and `thread_id`, and a persistent result
ends with the thread's id so a follow-up call can continue it. Resuming ignores `model` and `reasoning_effort`:
both are `thread/start` parameters and a resumed thread keeps the ones it was created with, while the per-turn
`effort` still applies.

**Why it is worth the change beyond convenience:** a resumed thread keeps the same prompt prefix, so the
endpoint's cache keeps hitting — measured on the Codex side at 93–99% of input tokens, against 0% for the same
work driven through a plan-usage route that refuses every cache control.

A thread with no turn yet is not resumable — the app-server answers `no rollout found` — so a thread becomes
continuable only after its first completed turn. A remembered session thread that has gone is replaced with a
fresh one; an id the caller passed explicitly is reported as a failure instead, because continuing it was the
whole request.

## 0.1.1


Documentation and packaging; no behaviour change.

The published `files` list named only `lib` and the patch, so an installed copy shipped **no licence and no
readme** — npm's own defaults covered neither once `files` was set. It now carries the licence, the readme, this
changelog and the Chinese page.

Joins a closing sentence that a blank line had split in two, and removes a `helper` entry from `files` that
named a directory this package does not have.

## 0.1.0

First release.

**A Codex delegation that can carry a model and a reasoning effort per call** — the two things
`@deepseek-ai/dsh-subagent-codex` cannot express. The Codex protocol supports both
(`ThreadStartParams.reasoningEffort`, `TurnStartParams.effort`); the official provider never sends them, and its
schema exposes neither, so a caller told to use a specific model and thinking level has nowhere to put either.

**Execution is a port of the official app-server adapter** (`src/wire.ts`, `src/run.ts`) — the initialize
handshake, the ephemeral thread, thread/turn association including notifications that arrive before
`turn/start` returns, unattended approval decisions, and terminal-answer selection — with `reasoningEffort` added
to `thread/start` and `effort` added to `turn/start`. The two literals appear nowhere in the official adapter.

**The tool is registered by this plugin itself**, on `agent/created`, into that Agent's own context, which keeps
the harness's preset-row machinery out of the path. Because the tool name is fixed, the official
`tool-subagent-codex` row stays disabled in those presets: two rows registering the same name in one scope
collide, and the second registration throws while its tool silently never appears.

**Defaults are deliberately absent.** What the call names is what runs; when it names neither, the choice stays
with Codex's own `~/.codex/config.toml`. The Host's `subagent-model-selection` setting is not consulted — it
governs a DSH catalog route billed as tokens, not a Codex model id under the CLI's own subscription.

**Background runs report progress.** `run_in_background` appends the child's completed commands, file changes,
and `commentary` messages to the job's output ring, so `job_output` shows how a long delegation is going.

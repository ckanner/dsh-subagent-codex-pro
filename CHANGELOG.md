# Changelog

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

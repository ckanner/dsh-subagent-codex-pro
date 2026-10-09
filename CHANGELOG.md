# Changelog

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

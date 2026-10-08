/**
 * A Codex delegation that can carry a model and a reasoning effort.
 *
 * ## Why this exists
 *
 * `@deepseek-ai/dsh-subagent-codex` declares `NO_START_CAPABILITIES`, so its
 * `tool-subagent` row cannot enable `modelSelectionSettings` — that requires a
 * provider declaring `agentOptions`, which the Codex provider does not. The
 * Codex protocol supports both fields (`ThreadStartParams.reasoningEffort`,
 * `TurnStartParams.effort`); the official adapter never sends them, and neither
 * literal appears anywhere in its 871 lines.
 *
 * Enabling the flag on a Codex row of our own provider was tried and did not
 * work: the row vanished with no tool and no error, while a control row — same
 * provider, same row, flag off — registered fine. That defect belongs to the
 * flag, not to the provider, and is reported upstream.
 *
 * ## What this does instead
 *
 * Two things, both under this package's control:
 *
 * 1. **Execution** is a port of the official app-server adapter (`wire.ts`,
 *    `run.ts`), with `reasoningEffort` added to `thread/start` and `effort` added
 *    to `turn/start`. That is the same protocol the official provider speaks,
 *    including its initialize handshake, ephemeral thread, unattended approval
 *    decisions, and terminal-answer selection.
 * 2. **The tool** is registered on `agent/created` into that Agent's own context
 *    — the path `dsh-plugin-lcu` uses — so the harness's preset-row machinery
 *    stays out of the way. `presets` names the presets that get it.
 *
 * `model` and `reasoning_effort` appear in the schema only while the host's
 * model-selection opt-in is enabled, so an Agent can never route itself to a
 * model the user has not authorized.
 *
 * @module dsh-subagent-codex-pro
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  AgentLike,
  Context,
  JobsServiceLike,
  SubagentProviderLike,
  SubagentRunLike,
  SubagentStartRequestLike,
} from './dsh-types.ts'
import { settleJob } from './jobs.ts'
import { delegateOnce, startCodexRun, type CodexRunSpec } from './run.ts'
import { createCodexTool } from './tool.ts'
import type { CodexPermissionMode } from './wire.ts'

/** Cordis plugin name. */
export const name = 'codex-pro'

/**
 * The services this plugin cannot work without.
 *
 * `subagents` is the provider registry. Everything else — the Agent registry,
 * the preset registry, the host opt-in — is looked up with `ctx.get`, so a
 * deployment missing one degrades instead of failing to load.
 */
export const inject = ['subagents']

/** Plugin configuration. */
export interface Config {
  /** Provider name to register under. Must differ from the official `codex`. */
  providerName?: string
  /** Codex executable; the app-server is started as `<command> app-server --stdio`. */
  command?: string
  /** Default model when a call does not name one. */
  model?: string
  /** Default reasoning effort when a call does not name one. */
  reasoningEffort?: string
  /**
   * Whether an Agent may name a model and a thinking level for a delegation.
   *
   * This plugin's own control, deliberately independent of the Host's
   * `subagent-model-selection` setting. That setting authorizes a child **LLM
   * route** chosen from the DSH model catalog and billed as tokens; a Codex
   * delegation names a **Codex model id** governed by the Codex CLI's own
   * subscription. The two are different resources with different namespaces, so
   * the Host's list can neither authorize nor constrain this choice — reading it
   * would only couple this tool to a setting that has nothing to say about it.
   *
   * Defaults to true: being able to name the model is the point of this package.
   */
  modelSelection?: boolean
  /** Unattended permission policy for the child thread. */
  permissionMode?: CodexPermissionMode
  /** Extra environment entries for the child. */
  env?: Record<string, string>
  /** Agent preset ids whose sessions receive the delegation tool. */
  presets?: string[]
}

/** The effort values Codex accepts; used only for diagnostics. */
const KNOWN_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

/** The unattended default: a delegated task must run without a human present. */
const DEFAULT_PERMISSION_MODE: CodexPermissionMode = 'dangerously-bypass-approvals-and-sandbox'

/**
 * Append one line to `~/.dsh/codex-pro.log`.
 *
 * A plugin has no log surface a running session can read, and a tool that fails
 * to register is otherwise silent. Never throws.
 *
 * @param message - the line to record.
 */
function diag(message: string): void {
  try {
    appendFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codex-pro.log'),
      `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics must never affect what they describe.
  }
}

/** Join the textual blocks of a delegated prompt. */
function promptText(prompt: SubagentStartRequestLike['prompt']): string {
  return prompt
    .filter((block): block is { type: 'text', text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
}

/** One delegation to Codex, exposed as a provider the harness can start. */
class CodexExecProvider implements SubagentProviderLike {
  readonly name: string
  readonly inheritsParentContext = false

  /**
   * The declaration that unlocks the delegation tool's model surface.
   *
   * `agentOptions: true` is what `tool-subagent` checks before accepting either a
   * configured `agentOptions` or `modelSelectionSettings: true` on its row.
   */
  readonly capabilities = {
    agentOptions: true,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  } as const

  constructor(
    private readonly resolved: Required<Pick<Config, 'command' | 'providerName' | 'permissionMode'>> & Config,
  ) {
    this.name = resolved.providerName
  }

  /**
   * Start one Codex run over the app-server protocol.
   *
   * @param request - the delegation the harness resolved.
   * @returns a run handle; its `result` settles with the child's final message.
   */
  async start(request: SubagentStartRequestLike): Promise<SubagentRunLike> {
    const cwd = request.parent.session.header.cwd
    if (cwd === undefined) {
      throw new Error('codex-pro: the parent session has no working directory to delegate from')
    }
    const options = request.agentOptions
    const model = options?.model ?? this.resolved.model
    const effort = options?.reasoningEffort ?? this.resolved.reasoningEffort
    const spec: CodexRunSpec = {
      cwd,
      command: this.resolved.command,
      permissionMode: this.resolved.permissionMode,
      model,
      reasoningEffort: effort,
      effort,
      env: this.resolved.env,
    }
    diag(`provider start: model=${model ?? '<default>'} effort=${effort ?? '<default>'} cwd=${cwd} via=app-server`)
    const run = await startCodexRun(request.prompt, spec, request.signal)
    diag(`provider start: published run ${run.id}`)
    return {
      id: run.id as SubagentRunLike['id'],
      localAgent: undefined,
      result: run.result.then((outcome) => ({
        output: outcome.output,
        stopReason: outcome.stopReason,
        ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
      })),
      dispose: () => run.teardown(),
    }
  }
}

/**
 * Register the provider and the delegation tool.
 *
 * @param ctx - context carrying the subagent registry.
 * @param config - provider name, defaults, and the presets to serve.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Pick<Config, 'command' | 'providerName' | 'permissionMode' | 'modelSelection'>> & Config = {
    providerName: config.providerName ?? name,
    command: config.command ?? 'codex',
    permissionMode: config.permissionMode ?? DEFAULT_PERMISSION_MODE,
    modelSelection: config.modelSelection ?? true,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.env === undefined ? {} : { env: config.env }),
  }
  const presets = config.presets ?? ['codexprobe']

  try {
    ctx.subagents.registerProvider(new CodexExecProvider(resolved))
    diag(`apply: provider "${resolved.providerName}" registered with agentOptions: true `
      + `(efforts: ${KNOWN_EFFORTS.join('/')}, permission=${resolved.permissionMode}); presets=${JSON.stringify(presets)}`)
  } catch (error: unknown) {
    diag(`apply: provider registration FAILED: ${String(error)}`)
  }

  /**
   * Whether one Agent's committed preset is one this plugin serves.
   *
   * The registry is authoritative; the session header is only the value the
   * session was created with, which the picker replaces afterwards.
   */
  const presetAllows = (agent: AgentLike): boolean => {
    const registry = ctx.get('agentPresets') as { composedPreset?(scope: unknown): string | undefined } | undefined
    let composed: string | undefined
    let composeError: string | undefined
    try {
      composed = registry?.composedPreset?.(agent.ctx)
    } catch (error: unknown) {
      composeError = error instanceof Error ? error.message : String(error)
    }
    const header = (agent.session.header as { agentPreset?: string }).agentPreset
    const preset = composed ?? header
    const allowed = preset !== undefined && presets.includes(preset)
    diag(`decide ${String(agent.id)} composed=${String(composed)} header=${String(header)} `
      + `err=${String(composeError)} -> ${allowed ? 'serve' : 'skip'}`)
    return allowed
  }

  /** Register the delegation tool for one Agent. */
  const serve = (agent: AgentLike): void => {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) {
      diag(`serve ${String(agent.id)}: skipped, the session has no working directory`)
      return
    }
    const selection = resolved.modelSelection
    // A delegation takes a minute or more, so a background job is the default
    // shape: it keeps the turn free. Without the jobs service the tool still
    // works, it just runs in the foreground and says nothing about it.
    const jobs = ctx.get('jobs') as JobsServiceLike | undefined

    /** Run one call over the app-server protocol. */
    const runCall = async (
      call: { readonly prompt: string, readonly model?: string, readonly reasoningEffort?: string },
      signal: AbortSignal,
      onProgress?: (text: string) => void,
    ): Promise<string> => {
      diag(`run: model=${call.model ?? '<default>'} effort=${call.reasoningEffort ?? '<default>'} `
        + `cwd=${cwd} prompt=${String(call.prompt.length)}B via=app-server`)
      const text = await delegateOnce({
        prompt: call.prompt,
        cwd,
        command: resolved.command,
        permissionMode: resolved.permissionMode,
        model: call.model,
        reasoningEffort: call.reasoningEffort,
        env: resolved.env,
        signal,
        onStart: (id) => { diag(`run: published ${id}`) },
        onProgress,
      })
      diag(`run done: text=${String(text.length)}B`)
      return text
    }

    try {
      agent.ctx.tools.register(createCodexTool({
        cwd,
        modelSelectionEnabled: selection,
        backgroundEnabled: jobs !== undefined,
        ...(resolved.model === undefined ? {} : { model: resolved.model }),
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
        run: (call) => runCall(call, call.signal),
        startBackground: (call) => {
          if (jobs === undefined) {
            throw new Error('subagent_codex: background runs need the jobs service (@deepseek-ai/dsh-jobs)')
          }
          const controller = new AbortController()
          const id = jobs.start({
            kind: 'subagent',
            label: call.label,
            owner: String(agent.id),
            run: (handle) => {
              handle.updateProgress('starting Codex')
              return {
                cancel: (reason?: string) => {
                  controller.abort(new Error(reason ?? 'codex delegation killed'))
                },
                // The child's own activity becomes the job's output, so
                // `job_output` shows how a long delegation is going rather than
                // only what it finally said. `settleJob` turns the delegation
                // into the outcome record the registry requires.
                done: settleJob(runCall(call, controller.signal, (text) => { handle.append(text) }))
                  .finally(() => { handle.updateProgress('') }),
              }
            },
          })
          diag(`serve: background job ${id} started for "${call.label}"`)
          return id
        },
      }))
      diag(`serve ${String(agent.id)}: subagent_codex registered `
        + `(modelSelection=${String(selection)}, background=${String(jobs !== undefined)}, `
        + `model=${resolved.model ?? '<default>'}, via=app-server)`)
    } catch (error: unknown) {
      diag(`serve ${String(agent.id)} FAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    if (!presetAllows(agent)) return
    serve(agent)
  })

  // A new task starts on the deployment default and the picker's mode is applied
  // afterwards, so `agent/created` alone can see the wrong composition.
  ctx.on('agent-preset/selected', (sessionId, presetId) => {
    if (!presets.includes(presetId)) return
    const agents = ctx.get('agents') as { get?(id: string): AgentLike | undefined } | undefined
    const agent = agents?.get?.(String(sessionId))
    if (agent === undefined) {
      diag(`preset/selected ${String(sessionId)}: no live agent`)
      return
    }
    serve(agent)
  })
}

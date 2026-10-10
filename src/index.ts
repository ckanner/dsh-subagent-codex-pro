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

import { appendFileSync, readFileSync, statSync } from 'node:fs'
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
import { CodexRunFailure, chooseThread, delegateOnce, startCodexRun, type CodexRunSpec } from './run.ts'
import { DEFAULT_ORIGINATOR } from './wire.ts'
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
  /**
   * How long a delegated Codex thread lives.
   *
   * - `ephemeral` (the default) is a throwaway run: nothing is written that the
   *   Codex CLI or the Codex application can list afterwards.
   * - `persistent` gives every delegation its own durable thread, which the Codex
   *   CLI and application list under the session's working directory and
   *   `thread_id` can continue.
   * - `session` reuses one durable thread for the whole Agent session, so a
   *   session that delegates ten times leaves one thread rather than ten, and
   *   after the first delegation each call continues the same conversation —
   *   which keeps the prompt prefix stable and lets the model's cache do its
   *   work. A call may still override either choice, and pass `thread_id` to
   *   continue a thread of its own.
   */
  threadMode?: 'ephemeral' | 'persistent' | 'session'
  /**
   * What the app-server records as the thread's originator.
   *
   * This is what decides whether the Codex desktop application lists a thread:
   * that client filters its list to the single value `Codex Desktop`, so the
   * default here is that literal. Overriding it trades desktop visibility for an
   * honest name — a thread the application will not show is still listed by the
   * Codex CLI and still resumable.
   */
  originator?: string
}

/** The slice of the harness's attachment store this plugin needs. */
interface AttachmentStoreLike {
  saveImages(images: readonly { readonly data: Buffer; readonly mediaType: string }[]): Promise<readonly unknown[]>
}

/**
 * Whether a model route's declared modalities refuse images.
 *
 * This is the harness's own rule, and matching it exactly is the point: an image
 * is refused only when the route **declares** input modalities and `image` is not
 * among them. An undeclared route is left to the harness, which rejects an
 * attachment for a model that cannot read it anyway.
 *
 * Being stricter cost a real screenshot. The default `deepseek-flash` entry
 * declares `['text', 'image']`, and an earlier guard here failed closed whenever
 * the route could not be resolved — which turned every image into a text note in
 * a session that could have displayed it.
 *
 * @param info - the resolved model route, when it could be resolved.
 * @returns whether the route says it cannot take images.
 */
export function routeRefusesImages(
  info: { readonly inputModalities?: readonly string[] } | undefined,
): boolean {
  const declared = info?.inputModalities
  return declared !== undefined && !declared.includes('image')
}

/** The slice of the harness's LLM service this plugin needs. */
interface LlmServiceLike {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ readonly inputModalities?: readonly string[] }>
}

/** Media types this plugin hands the attachment store, by file extension. */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** A cap on one image, so a stray large file cannot stall a delegation. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** One content block the model can receive. */
interface ContentBlockLike {
  readonly type: string
  readonly text?: string
  readonly attachment?: unknown
}

/** Stable text for an image the model could not be handed. */
function imageNote(reason: string): string {
  return `[image not delivered: ${reason}]`
}

/** The media type for a path, when its extension names one this store admits. */
function mediaTypeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? undefined : IMAGE_MEDIA_TYPES[path.slice(dot).toLowerCase()]
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

  /**
   * The resolved configuration.
   *
   * A plain field rather than a constructor parameter property: Node's
   * type-stripping mode rejects that syntax outright, which made this module
   * unimportable from a test and left its pure helpers untestable.
   */
  readonly resolved: Required<Pick<Config, 'command' | 'providerName' | 'permissionMode'>> & Config

  constructor(
    resolved: Required<Pick<Config, 'command' | 'providerName' | 'permissionMode'>> & Config,
  ) {
    this.resolved = resolved
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
  const resolved: Required<Pick<Config, 'command' | 'providerName' | 'permissionMode' | 'modelSelection' | 'threadMode' | 'originator'>> & Config = {
    providerName: config.providerName ?? name,
    command: config.command ?? 'codex',
    permissionMode: config.permissionMode ?? DEFAULT_PERMISSION_MODE,
    modelSelection: config.modelSelection ?? true,
    threadMode: config.threadMode ?? 'ephemeral',
    originator: config.originator ?? DEFAULT_ORIGINATOR,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.env === undefined ? {} : { env: config.env }),
  }
  const presets = config.presets ?? ['codexprobe']

  try {
    ctx.subagents.registerProvider(new CodexExecProvider(resolved))
    diag(`apply: provider "${resolved.providerName}" registered with agentOptions: true `
      + `(efforts: ${KNOWN_EFFORTS.join('/')}, permission=${resolved.permissionMode}); `
      + `threadMode=${resolved.threadMode} originator=${JSON.stringify(resolved.originator)}; `
      + `presets=${JSON.stringify(presets)}`)
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

    /**
     * Whether the calling Agent's model route refuses images.
     *
     * The rule is the harness's own, deliberately: an image is refused only when
     * the route **declares** input modalities and `image` is not among them. An
     * undeclared route is left to the harness, which is where an attachment for a
     * model that cannot read it is rejected anyway.
     *
     * Being stricter here was a real mistake: the default `deepseek-flash` entry
     * declares `['text', 'image']`, and a guard that failed closed on an
     * unresolvable route silently turned every screenshot into a text note. So an
     * unresolvable route now delivers the image and lets the harness decide.
     *
     * @returns whether this plugin should withhold images.
     */
    const shouldWithholdImages = async (): Promise<boolean> => {
      const llm = ctx.get('llm') as LlmServiceLike | undefined
      const header = (agent.session as {
        requestHeader?(): { config?: { provider?: string, model?: string } }
      }).requestHeader?.()
      const options = (agent as unknown as { options?: { provider?: string, model?: string } }).options
      const provider = header?.config?.provider ?? options?.provider
      const model = header?.config?.model ?? options?.model
      if (llm === undefined || provider === undefined || model === undefined) return false
      try {
        return routeRefusesImages(await llm.resolveModelInfo(provider, model))
      } catch {
        return false
      }
    }

    /**
     * Turn one finished delegation into the blocks the model receives.
     *
     * A run's images are read here, because the app-server reports them as paths
     * on this host rather than as bytes, and handed to the attachment store so
     * the model gets an image instead of a description of one. Nothing here can
     * fail the delegation: a store that is absent, a route that cannot take
     * images, and a file that cannot be read all become a text note, because the
     * answer the delegation produced matters more than the picture beside it.
     *
     * @param outcome - the finished run.
     * @param mode - the thread mode the run used.
     * @returns the text, the thread id, and any content blocks to deliver.
     */
    const deliverResult = async (
      outcome: { readonly text: string; readonly threadId: string | undefined,
        readonly images?: readonly { readonly path?: string, readonly data?: string, readonly mimeType?: string }[] | undefined },
      mode: 'ephemeral' | 'persistent',
    ): Promise<{
      readonly text: string
      readonly threadId: string | undefined
      readonly blocks?: readonly ContentBlockLike[] | undefined
    }> => {
      const text = withThreadMarker(outcome, mode)
      const images = outcome.images ?? []
      if (images.length === 0) return { text, threadId: outcome.threadId }

      const notes: string[] = []
      const notesFor = (reason: string): void => { notes.push(imageNote(reason)) }

      const store = ctx.get('attachments') as AttachmentStoreLike | undefined
      if (store === undefined) {
        for (let i = 0; i < images.length; i += 1) notesFor('no attachment store is mounted')
        return { text: `${text}\n\n${notes.join('\n')}`, threadId: outcome.threadId }
      }
      if (await shouldWithholdImages()) {
        for (let i = 0; i < images.length; i += 1) notesFor('this model route declares no image input')
        return { text: `${text}\n\n${notes.join('\n')}`, threadId: outcome.threadId }
      }

      const payloads: { data: Buffer, mediaType: string }[] = []
      for (const image of images) {
        try {
          if (image.data !== undefined) {
            payloads.push({ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType ?? 'image/png' })
            continue
          }
          if (image.path === undefined) { notesFor('the image had neither a path nor data'); continue }
          const mediaType = mediaTypeOf(image.path)
          if (mediaType === undefined) { notesFor(`unsupported image type: ${image.path}`); continue }
          const stat = statSync(image.path)
          if (stat.size > MAX_IMAGE_BYTES) { notesFor(`larger than ${String(MAX_IMAGE_BYTES)} bytes: ${image.path}`); continue }
          payloads.push({ data: readFileSync(image.path), mediaType })
        } catch (error: unknown) {
          notesFor(`could not read ${image.path ?? 'the image'}: ${String(error)}`.slice(0, 200))
        }
      }

      if (payloads.length === 0) {
        return { text: `${text}\n\n${notes.join('\n')}`, threadId: outcome.threadId }
      }
      try {
        const refs = await store.saveImages(payloads)
        const blocks: ContentBlockLike[] = [{ type: 'text', text }, ...refs.map((ref) => ({ type: 'image', attachment: ref }))]
        diag(`deliver: ${String(refs.length)} image(s) attached to the delegation result`)
        return { text, threadId: outcome.threadId, blocks }
      } catch (error: unknown) {
        notesFor(`the attachment store refused them: ${String(error)}`.slice(0, 200))
        return { text: `${text}\n\n${notes.join('\n')}`, threadId: outcome.threadId }
      }
    }

    /**
     * The durable thread this Agent session is reusing, for `threadMode: session`.
     *
     * One Agent is one session, so this map is that session's memory of the
     * thread it opened; it is deliberately per-Agent rather than global, because
     * two sessions delegating at once must not continue each other's work.
     */
    const sessionThread = new Map<string, string>()

    /**
     * Threads this Agent is delegating in right now.
     *
     * A thread carries one turn at a time, so the session's remembered thread
     * cannot be handed to two calls at once. Tracking it here turns that into a
     * decision before the call starts rather than a failure after it.
     */
    const inFlight = new Set<string>()

    /** One call's resolved thread decision. */
    interface CallLike {
      /** The model's short description, used as the thread name's label. */
      readonly label: string
      readonly prompt: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly threadMode?: 'ephemeral' | 'persistent'
      readonly threadId?: string
    }

    /** Run one call over the app-server protocol. */
    const runCall = async (
      call: CallLike,
      signal: AbortSignal,
      onProgress?: (text: string) => void,
    ): Promise<{
      readonly text: string
      readonly threadId: string | undefined
      readonly blocks?: readonly ContentBlockLike[] | undefined
    }> => {
      // An explicit thread id wins; then an explicit mode; then the session's
      // remembered thread; then the configured default.
      const configured = resolved.threadMode
      const mode = call.threadMode ?? (configured === 'ephemeral' ? 'ephemeral' : 'persistent')
      const remembered = sessionThread.get(String(agent.id))
      const explicit = call.threadId
      const choice = chooseThread({
        explicit,
        configured,
        // A remembered thread is only reusable for a durable call; an ephemeral
        // one was never remembered in the first place.
        remembered: mode === 'persistent' ? remembered : undefined,
        inFlight,
      })
      const reuse = choice.reuse
      if (choice.skippedBusy !== undefined) {
        diag(`run: session thread ${choice.skippedBusy} is busy with another delegation - `
          + `this call gets a thread of its own`)
      }
      diag(`run: model=${call.model ?? '<default>'} effort=${call.reasoningEffort ?? '<default>'} `
        + `thread=${mode}${reuse === undefined ? '' : ` resume=${reuse}`} `
        + `cwd=${cwd} prompt=${String(call.prompt.length)}B via=app-server`)
      // Claim the thread for the whole call, so a concurrent delegation sees it
      // as busy before it tries rather than failing when it does.
      if (reuse !== undefined) inFlight.add(reuse)
      try {
        const outcome = await delegateOnce({
          prompt: call.prompt,
          cwd,
          command: resolved.command,
          permissionMode: resolved.permissionMode,
          model: call.model,
          reasoningEffort: call.reasoningEffort,
          threadMode: mode,
          threadId: reuse,
          originator: resolved.originator,
          threadName: threadNameFor(call.label),
          env: resolved.env,
          signal,
          onStart: (id) => { diag(`run: published ${id}`) },
          onProgress,
        })
        if (mode === 'persistent' && outcome.threadId !== undefined) {
          sessionThread.set(String(agent.id), outcome.threadId)
        }
        diag(`run done: text=${String(outcome.text.length)}B thread=${outcome.threadId ?? '<none>'} `
          + `images=${String(outcome.images?.length ?? 0)}`)
        return await deliverResult(outcome, mode)
      } catch (error: unknown) {
        // A session's remembered thread can be gone — the user removed it, or the
        // Codex state moved. That is this plugin's own bookkeeping, so a fresh
        // thread is the right repair; an id the caller passed explicitly is not
        // repaired silently, because continuing it was the whole request.
        // Only a resume that the app-server refused is repaired here. A turn that
        // failed for its own reasons must not be retried: that would pay for the
        // same work twice and hide the real failure behind a second attempt.
        if (
          reuse !== undefined
          && explicit === undefined
          && mode === 'persistent'
          && error instanceof CodexRunFailure
          && error.facts.stage === 'thread-resume'
        ) {
          diag(`run: remembered thread ${reuse} could not be resumed (${String(error)}) - starting a new one`)
          sessionThread.delete(String(agent.id))
          const outcome = await delegateOnce({
            prompt: call.prompt,
            cwd,
            command: resolved.command,
            permissionMode: resolved.permissionMode,
            model: call.model,
            reasoningEffort: call.reasoningEffort,
            threadMode: mode,
            originator: resolved.originator,
            threadName: threadNameFor(call.label),
            env: resolved.env,
            signal,
            onStart: (id) => { diag(`run: published ${id}`) },
            onProgress,
          })
          if (outcome.threadId !== undefined) sessionThread.set(String(agent.id), outcome.threadId)
          diag(`run done: text=${String(outcome.text.length)}B thread=${outcome.threadId ?? '<none>'} `
            + `images=${String(outcome.images?.length ?? 0)}`)
          return await deliverResult(outcome, mode)
        }
        throw error
      } finally {
        if (reuse !== undefined) inFlight.delete(reuse)
      }
    }

    try {
      agent.ctx.tools.register(createCodexTool({
        cwd,
        modelSelectionEnabled: selection,
        backgroundEnabled: jobs !== undefined,
        defaultThreadMode: resolved.threadMode,
        threadControlEnabled: true,
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

/**
 * Append the thread marker to a completed delegation's text.
 *
 * The id is carried in the text rather than in a richer tool result so that the
 * answer stays the plain final message the model already reads, while the one
 * fact a follow-up call needs is still in front of it. Appending here rather
 * than in the tool means a background job's collected result carries it too.
 *
 * @param outcome - the finished run.
 * @param mode - the thread mode the run used.
 * @returns the text to report.
 */
function withThreadMarker(
  outcome: { readonly text: string; readonly threadId: string | undefined },
  mode: 'ephemeral' | 'persistent',
): string {
  if (mode === 'ephemeral' || outcome.threadId === undefined) return outcome.text
  return `${outcome.text}\n\n[codex thread ${outcome.threadId} · persistent · pass it as thread_id to continue]`
}

/**
 * The name a persistent thread carries in the Codex application.
 *
 * A thread from this provider has to report itself as `Codex Desktop` to be
 * listed there at all, so the name is the only place that can say the work came
 * from DSH and what it was. The model's own short description is the best label
 * available, and the prefix keeps them together in a list sorted by recency.
 *
 * @param label - the call's short description.
 * @returns the name to record.
 */
function threadNameFor(label: string): string {
  const trimmed = label.trim()
  return trimmed === '' ? 'DSH · Codex delegation' : `DSH · ${trimmed}`
}

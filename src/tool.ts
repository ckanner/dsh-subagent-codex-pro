/**
 * The model-facing delegation tool.
 *
 * `@deepseek-ai/dsh-tool-subagent` cannot give an external provider the model
 * surface: a row may only carry `modelSelectionSettings: true` when the provider
 * declares `agentOptions`, and enabling it on the Codex row inside a preset
 * makes that row disappear — silently, with no tool and no error. The control
 * row in those experiments (same provider, same row, flag off) did register, so
 * the provider and the row shape are both fine.
 *
 * So this plugin registers the tool itself, the way the LCU plugin registers
 * `js`: on `agent/created`, into that agent's own context. `model` and
 * `reasoning_effort` appear while this plugin's modelSelection setting is
 * enabled; that setting is independent of the Host LLM route picker.
 *
 * @module dsh-subagent-codex-pro/tool
 */

import type { ToolDefinitionLike } from './dsh-types.ts'
import type { CodexPermissionMode } from './wire.ts'
import { desktopNativeSchema, reviewTargetSchema, parseDesktopNative, nativeDiagnostic, type DesktopNative } from './desktop-native.ts'
import { parseNativeRequest, type NativeRequest, type NativeReceipt } from './native.ts'

/** One call's choices, already resolved against the configured defaults. */
export interface CodexCall {
  readonly native?: DesktopNative
  /** Set only by the dedicated review tool; normal delegation rejects native.review. */
  readonly review?: NativeRequest['review']
  readonly label: string
  readonly prompt: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** Per-call permission mode override, when the caller chose one. */
  readonly permissionMode?: CodexPermissionMode
  /** How long this delegation's thread lives, when the call chose. */
  readonly threadMode?: 'ephemeral' | 'persistent'
  /** Continue this thread instead of creating one. */
  readonly threadId?: string
  /** Working directory for the delegation, when the call named one. */
  readonly cwd?: string
  /** Absolute paths of images to show Codex alongside the task. */
  readonly images?: readonly string[]
  /** A JSON Schema the final answer must conform to. */
  readonly outputSchema?: Record<string, unknown>
  /** Deadline for this call in milliseconds; `0` means no deadline. */
  readonly timeoutMs?: number
}

/** Everything the tool needs that does not change per call. */
export interface CodexToolOptions {
  /** The delegating Agent's working directory. */
  readonly cwd: string
  /** Default model when a call does not name one. */
  readonly model?: string
  /** Default reasoning effort when a call does not name one. */
  readonly reasoningEffort?: string
  /** Configured permission policy; limits the per-call enum to safe choices. */
  readonly permissionMode?: CodexPermissionMode
  /**
   * Whether the plugin permits Agent-chosen Codex models.
   *
   * When false the tool exposes no `model` or `reasoning_effort`, exactly as the
   * harness's own delegation tools behave — the user's authorization is the only
   * thing that makes those fields exist.
   */
  readonly modelSelectionEnabled: boolean
  /** Whether the jobs service is present, which is what makes background runs possible. */
  readonly backgroundEnabled: boolean
  /** The plugin's configured thread mode, named in the tool description. */
  readonly defaultThreadMode: 'ephemeral' | 'persistent' | 'session'
  /** Whether a call may override the thread mode and resume a thread. */
  readonly threadControlEnabled: boolean
  /** Run one delegation and return its final text and the thread it used. */
  readonly run: (request: CodexCall & { readonly signal: AbortSignal }) => Promise<{
    readonly text: string
    readonly threadId: string | undefined
    readonly native?: NativeReceipt
    /**
     * Content blocks to hand the model, when the run produced more than text.
     *
     * A foreground delegation returns these so a screenshot the run took reaches
     * the model as an image. A background job's result is a string by contract,
     * so its images are reported by host path in the text instead.
     */
    readonly blocks?: readonly { readonly type: string }[] | undefined
  }>
  /**
   * Start one delegation as a background job.
   *
   * @param request - the call's label and resolved choices.
   * @returns the job id the model collects with `job_output`.
   */
  readonly startBackground: (request: CodexCall) => string
}

/**
 * Permission modes a per-call override may select without changing the
 * configured policy upward.
 *
 * The tool description and schema should not advertise a choice that the
 * runtime's narrowing guard will reject. When no policy is supplied (direct
 * tests or older callers), all modes remain visible for compatibility.
 */
export function allowedPermissionModes(
  configured: CodexPermissionMode | undefined,
): readonly CodexPermissionMode[] {
  const modes: CodexPermissionMode[] = [
    'read-only', 'workspace-write', 'never', 'approve-for-me', 'dangerously-bypass-approvals-and-sandbox',
  ]
  if (configured === undefined) return modes
  return modes.filter((mode) => mode === configured || mode === 'read-only'
    || (configured === 'dangerously-bypass-approvals-and-sandbox' && mode === 'workspace-write'))
}

/**
 * Build the delegation tool definition.
 *
 * @param options - the delegating Agent's fixed choices, its runner, and its
 * background starter.
 * @returns a definition ready for `agent.ctx.tools.register`.
 */
export function createCodexTool(options: CodexToolOptions): ToolDefinitionLike {
  const permissionModes = allowedPermissionModes(options.permissionMode)
  const effortHint = options.reasoningEffort === undefined
    ? ''
    : ` Leave it unset to use the configured ${options.reasoningEffort}.`
  return {
    name: 'subagent_codex',
    description:
      'Delegate one self-contained task to Codex and return its final message. Codex runs in this session\'s '
      + 'working directory with its own tools, so the prompt must be self-contained: it cannot see this '
      + 'conversation. Prefer one delegation per independent task, and start independent delegations together '
      + 'in one assistant message.'
      + (options.modelSelectionEnabled
        ? ' `model` and `reasoning_effort` choose this delegation\'s Codex model and thinking level; omit them'
          + ' to use the configured defaults.'
        : '')
      + (options.backgroundEnabled
        ? ' A delegation typically takes a minute or more: set `run_in_background` unless your next action'
          + ' depends on the result.'
        : '')
      + ' Native agent defaults come from the plugin settings. Supply native to replace them for this call;'
      + ' null turns agents off. Native operations still run inside Codex with the same permission boundary.'
      + ' Use subagent_codex_review for an explicit native review operation.'
      + ' A delegation is cancelled if it exceeds the deadline the plugin is configured with, and the result says so.'
      + (options.threadControlEnabled
        ? ' A delegation runs in a Codex thread whose lifetime is `'
          + options.defaultThreadMode
          + '` by default. Set `thread_mode: "persistent"` when the user wants to see, reopen, or continue this'
          + ' work in Codex itself — such a thread appears in the Codex application under this workspace and'
          + ' its id is reported with the result. Set `thread_mode: "ephemeral"` for a run that must leave no'
          + ' trace. Pass `thread_id` to continue an earlier thread instead of starting one; supplied'
          + ' `model`, `cwd`, and `permission_mode` override that thread when present, and an explicit'
          + ' thread id is never silently replaced by a different thread.'
        : ''),
    // A whole JSON Schema object: the harness rejects anything that is not
    // `type: "object"`.
    parameters: {
      type: 'object',
      properties: {
        native: desktopNativeSchema,
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'The complete task for Codex, including everything it needs and cannot ask for.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Deadline for this delegation in milliseconds, overriding the configured default'
            + ' (which the plugin reports when it starts). Use it when the user asks for a longer or shorter'
            + ' run than usual — a release smoke test takes tens of minutes, where a quick lookup does not.'
            + ' `0` means no deadline at all. A run that passes the deadline is cancelled and says so.',
        },
        output_schema: {
          type: 'object',
          description: 'A JSON Schema (object-rooted) the final answer must conform to. Codex enforces it,'
            + ' so the result is JSON that conforms rather than prose to parse and hope about — use it'
            + ' whenever a later step reads the answer mechanically, such as a verdict or a list of'
            + ' failures. The answer still arrives as text; it is JSON text.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths of images to show Codex alongside the task — a screenshot it'
            + ' should look at, a design it should match. Each path must exist and be a readable image.'
            + ' Codex receives them as images, so it does not have to go and open the files itself.'
            + ' Prefer this over writing a path into `prompt`.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute path to run the delegation in. Defaults to this session\'s working'
            + ' directory. Use it when the work belongs somewhere else — a scratch directory the run may'
            + ' write into, for instance. The path must exist and be a directory. Naming one starts a fresh'
            + ' Codex thread unless an explicit `thread_id` is supplied, in which case it is applied as a'
            + ' resume override.',
        },
        permission_mode: {
          type: 'string',
          enum: permissionModes,
          description: 'Permission mode for this delegation. Only modes that cannot expand the configured'
            + ' policy are listed. `read-only` is the safe Review mode:'
            + ' approvalPolicy=never plus a read-only sandbox. `workspace-write` combines never with'
            + ' the workspace-write sandbox. Per-call overrides may only narrow the configured policy.'
            + ' `never` alone is not read-only. Omit to use'
            + ' the provider configuration; leave the configured write mode alone for implementation work.',
        },
        ...options.modelSelectionEnabled
          ? {
              model: {
                type: 'string',
                description: 'Codex model id for this delegation, exactly as the user named it. Omit to'
                  + ' leave the choice to Codex\'s own configuration; Codex accepts ids this session cannot'
                  + ' enumerate.',
              },
              reasoning_effort: {
                type: 'string',
                description: 'Codex thinking level for this delegation, such as `low`, `medium`, `high`, or'
                  + ` \`xhigh\`.${effortHint}`,
              },
            }
          : {},
        ...options.backgroundEnabled
          ? {
              run_in_background: {
                type: 'boolean',
                description: 'Run as a background job and return its id (collect with `job_output`, stop with'
                  + ' `job_kill`). Defaults to false; set it unless your next action depends on the result.',
              },
            }
          : {},
        ...options.threadControlEnabled
          ? {
              thread_mode: {
                type: 'string',
                enum: ['ephemeral', 'persistent'],
                description: 'Lifetime of this delegation\'s Codex thread. `persistent` keeps the thread after'
                  + ' the run: it appears in the Codex application under this workspace and can be continued'
                  + ' later by passing its id as `thread_id`. It also keeps the prompt prefix stable, so later'
                  + ' resumes read from the model\'s cache. `ephemeral` is a throwaway run that leaves nothing'
                  + ' behind. Omit to use the configured default.',
              },
              thread_id: {
                type: 'string',
                description: 'Continue an existing Codex thread instead of creating one. Pass the id a previous'
                  + ' delegation reported. Supplied `model`, `cwd`, and `permission_mode` are applied as'
                  + ' resume overrides; `reasoning_effort` remains a per-turn setting. An explicit id always'
                  + ' continues that thread: a failed resume is reported, never silently replaced.',
              },
            }
          : {},
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    output: {
      // A foreground call answers with content blocks, so an image the run
      // produced reaches the model as an image rather than as a description of
      // one. A background call answers with the job handle its reader collects.
      schema: options.backgroundEnabled
        ? {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: { content: { type: 'array', items: {} }, native: { type: 'object' } },
                required: ['content'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', const: 'background' },
                  jobId: { type: 'string' },
                },
                required: ['kind', 'jobId'],
              },
            ],
          }
        : {
            type: 'object',
            additionalProperties: false,
            properties: { content: { type: 'array', items: {} }, native: { type: 'object' } },
            required: ['content'],
          },
      render: (_args: unknown, value: unknown) => {
        if (isBackgroundHandle(value)) {
          return [{
            type: 'text' as const,
            text: `Started as background job ${value.jobId}. Collect its result with job_output.`,
          }]
        }
        const content = isContentResult(value) ? value.content : []
        const rendered: ({ type: 'text'; text: string } | { type: 'image'; attachment: unknown })[] = []
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') rendered.push({ type: 'text', text: block.text })
          else if (block.type === 'image' && block.attachment !== undefined) {
            rendered.push({ type: 'image', attachment: block.attachment })
          }
        }
        if (rendered.length === 0) rendered.push({ type: 'text', text: '(the delegation produced no text)' })
        const native = typeof value === 'object' && value !== null && 'native' in value
          ? value.native as NativeReceipt | undefined : undefined
        if (native !== undefined) rendered.push({ type: 'text', text: nativeDiagnostic(native) })
        return rendered
      },
    },
    async execute(args: unknown, exec: { readonly signal: AbortSignal }): Promise<unknown> {
      const allowed = ['description', 'prompt', 'native', 'timeout_ms', 'output_schema', 'images', 'cwd', 'permission_mode',
        ...(options.modelSelectionEnabled ? ['model', 'reasoning_effort'] : []),
        ...(options.backgroundEnabled ? ['run_in_background'] : []),
        ...(options.threadControlEnabled ? ['thread_mode', 'thread_id'] : [])]
      const request = checkedArguments(args, allowed, 'subagent_codex')
      const prompt = typeof request.prompt === 'string' && request.prompt.trim() !== ''
        ? optionalText(request, 'prompt') : undefined
      if (prompt === undefined) throw new Error('subagent_codex: `prompt` is required and must not be empty')
      const model = optionalText(request, 'model') ?? options.model
      const effort = optionalText(request, 'reasoning_effort') ?? options.reasoningEffort
      const label = optionalText(request, 'description') ?? 'Codex delegation'
      const cwd = optionalText(request, 'cwd')
      const timeoutMs = request.timeout_ms
      if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
        throw new Error('subagent_codex: timeout_ms must be non-negative safe integer milliseconds')
      }
      const outputSchema = request.output_schema
      if (outputSchema !== undefined && (typeof outputSchema !== 'object' || outputSchema === null
        || Array.isArray(outputSchema) || !('type' in outputSchema) || outputSchema.type !== 'object')) {
        throw new Error('subagent_codex: output_schema must be an object-rooted JSON Schema')
      }
      const permissionMode = request.permission_mode
      if (permissionMode !== undefined && !permissionModes.includes(permissionMode as CodexPermissionMode)) {
        throw new Error('subagent_codex: permission_mode is invalid or exceeds the configured policy')
      }
      const images = request.images
      if (images !== undefined && (!Array.isArray(images) || images.some(value => typeof value !== 'string' || value.trim() === ''))) {
        throw new Error('subagent_codex: images must be an array of non-empty paths')
      }
      const threadMode = request.thread_mode
      if (threadMode !== undefined && threadMode !== 'ephemeral' && threadMode !== 'persistent') {
        throw new Error('subagent_codex: thread_mode must be ephemeral or persistent')
      }
      const threadId = optionalText(request, 'thread_id')
      if (threadId !== undefined && threadMode === 'ephemeral') throw new Error('subagent_codex: thread_id requires a persistent thread')
      if (request.run_in_background !== undefined && typeof request.run_in_background !== 'boolean') {
        throw new Error('subagent_codex: run_in_background must be a boolean')
      }
      const native = parseDesktopNative(request.native)
      const call: CodexCall = {
        label, prompt,
        ...(request.native === undefined ? {} : { native: request.native === null ? null : native! }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(permissionMode === undefined ? {} : { permissionMode: permissionMode as CodexPermissionMode }),
        ...(threadMode === undefined ? {} : { threadMode }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(images === undefined || (images as string[]).length === 0 ? {} : { images: images as string[] }),
        ...(outputSchema === undefined ? {} : { outputSchema: outputSchema as Record<string, unknown> }),
        ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
      }
      if (options.backgroundEnabled && request.run_in_background === true) {
        return { kind: 'background' as const, jobId: options.startBackground(call) }
      }
      const { text, blocks, native: receipt } = await options.run({ ...call, signal: exec.signal })
      return { content: blocks ?? [{ type: 'text', text }], ...(receipt === undefined ? {} : { native: receipt }) }
    },
  }
}

/** Whether a tool result carries content blocks. */
function isContentResult(value: unknown): value is { content: readonly { type: string; text?: string; attachment?: unknown }[] } {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as { content?: unknown }).content)
}

/** Whether a tool result is the background handle shape. */
function isBackgroundHandle(value: unknown): value is { jobId: string } {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'background'
    && typeof (value as { jobId?: unknown }).jobId === 'string'
}


/** Reject unknown keys even when a caller bypasses the Host's JSON Schema validator. */
function checkedArguments(args: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error(name + ': arguments must be an object')
  const request = args as Record<string, unknown>
  const unexpected = Object.keys(request).find(key => !allowed.includes(key))
  if (unexpected !== undefined) throw new Error(name + ': unsupported argument ' + unexpected)
  return request
}

function optionalText(request: Record<string, unknown>, key: string): string | undefined {
  const value = request[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error('subagent_codex: ' + key + ' must be a non-empty string')
  }
  return value
}

/**
 * A fresh read-only review/start operation. Target is explicit; prompt, images,
 * output_schema, thread_id and native defaults cannot change or be ignored by it.
 */
export function createCodexReviewTool(options: CodexToolOptions): ToolDefinitionLike {
  const common = createCodexTool({ ...options, permissionMode: 'read-only', defaultThreadMode: 'ephemeral', threadControlEnabled: false })
  const commonProperties = common.parameters.properties as Record<string, unknown>
  const allowed = ['description', 'target', 'timeout_ms', 'cwd',
    ...(options.modelSelectionEnabled ? ['model', 'reasoning_effort'] : []),
    ...(options.backgroundEnabled ? ['run_in_background'] : [])]
  return {
    name: 'subagent_codex_review',
    description: 'Run an explicit native Codex review of uncommitted changes, a base branch, a commit, or custom review instructions. '
      + 'Always uses a fresh ephemeral thread, a read-only sandbox, unattended approvals=never, and agents off. '
      + 'Ordinary delegation and plugin native defaults never invoke review. Choose the target explicitly; there is no ignored task prompt, resume, images, or output schema.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['description', 'target'],
      properties: Object.fromEntries(allowed.map(key => [key, key === 'target' ? reviewTargetSchema : commonProperties[key]])),
    },
    output: common.output,
    async execute(args, exec) {
      const request = checkedArguments(args, allowed, 'subagent_codex_review')
      const native = parseNativeRequest({ version: 1, agents: { enabled: false }, review: { target: request.target } })
      const review = native.review!
      const tool = createCodexTool({
        ...options, permissionMode: 'read-only', defaultThreadMode: 'ephemeral', threadControlEnabled: false,
        run: call => options.run({ ...call, review, threadMode: 'ephemeral', permissionMode: 'read-only' }),
        startBackground: call => options.startBackground({ ...call, review, threadMode: 'ephemeral', permissionMode: 'read-only' }),
      })
      const { target: _target, ...values } = request
      return await tool.execute({ ...values, prompt: 'Run the explicitly requested native review.', native: null }, exec)
    },
  }
}

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
 * `reasoning_effort` appear only while the host's model-selection opt-in is
 * enabled, so an Agent cannot route itself to a model the user has not
 * authorized.
 *
 * @module dsh-subagent-codex-pro/tool
 */

import type { ToolDefinitionLike } from './dsh-types.ts'

/** One call's choices, already resolved against the configured defaults. */
export interface CodexCall {
  readonly label: string
  readonly prompt: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** How long this delegation's thread lives, when the call chose. */
  readonly threadMode?: 'ephemeral' | 'persistent'
  /** Continue this thread instead of creating one. */
  readonly threadId?: string
}

/** Everything the tool needs that does not change per call. */
export interface CodexToolOptions {
  /** The delegating Agent's working directory. */
  readonly cwd: string
  /** Default model when a call does not name one. */
  readonly model?: string
  /** Default reasoning effort when a call does not name one. */
  readonly reasoningEffort?: string
  /**
   * Whether the host opted in to Agent-chosen models.
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
  readonly run: (request: CodexCall & { readonly signal: AbortSignal }) =>
    Promise<{ readonly text: string; readonly threadId: string | undefined }>
  /**
   * Start one delegation as a background job.
   *
   * @param request - the call's label and resolved choices.
   * @returns the job id the model collects with `job_output`.
   */
  readonly startBackground: (request: CodexCall) => string
}

/**
 * Build the delegation tool definition.
 *
 * @param options - the delegating Agent's fixed choices, its runner, and its
 * background starter.
 * @returns a definition ready for `agent.ctx.tools.register`.
 */
export function createCodexTool(options: CodexToolOptions): ToolDefinitionLike {
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
      + (options.threadControlEnabled
        ? ' A delegation runs in a Codex thread whose lifetime is `'
          + options.defaultThreadMode
          + '` by default. Set `thread_mode: "persistent"` when the user wants to see, reopen, or continue this'
          + ' work in Codex itself — such a thread appears in the Codex application under this workspace and'
          + ' its id is reported with the result. Set `thread_mode: "ephemeral"` for a run that must leave no'
          + ' trace. Pass `thread_id` to continue an earlier thread instead of starting one; that thread keeps'
          + ' its original model and thinking level, so `model` and `reasoning_effort` are ignored then.'
        : ''),
    // A whole JSON Schema object: the harness rejects anything that is not
    // `type: "object"`.
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'The complete task for Codex, including everything it needs and cannot ask for.',
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
                  + ' delegation reported. The thread keeps its original model and thinking level, so `model`'
                  + ' and `reasoning_effort` are ignored for this call.',
              },
            }
          : {},
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    output: {
      // A background call returns a handle, a foreground call returns the answer.
      schema: options.backgroundEnabled
        ? {
            oneOf: [
              { type: 'string' },
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
        : { type: 'string' },
      render: (_args: unknown, value: unknown) => [{
        type: 'text' as const,
        text: typeof value === 'string'
          ? value
          : isBackgroundHandle(value)
            ? `Started as background job ${value.jobId}. Collect its result with job_output.`
            : JSON.stringify(value),
      }],
    },
    async execute(args: unknown, exec: { readonly signal: AbortSignal }): Promise<unknown> {
      const request = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const prompt = typeof request.prompt === 'string' ? request.prompt : ''
      if (prompt === '') throw new Error('subagent_codex: `prompt` is required and must not be empty')
      const model = typeof request.model === 'string' && request.model !== '' ? request.model : options.model
      const effort = typeof request.reasoning_effort === 'string' && request.reasoning_effort !== ''
        ? request.reasoning_effort
        : options.reasoningEffort
      const label = typeof request.description === 'string' && request.description !== ''
        ? request.description
        : 'Codex delegation'
      const threadMode = request.thread_mode === 'ephemeral' || request.thread_mode === 'persistent'
        ? request.thread_mode
        : undefined
      const threadId = typeof request.thread_id === 'string' && request.thread_id !== ''
        ? request.thread_id
        : undefined
      const call: CodexCall = {
        label,
        prompt,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(threadMode === undefined ? {} : { threadMode }),
        ...(threadId === undefined ? {} : { threadId }),
      }
      if (options.backgroundEnabled && request.run_in_background === true) {
        return { kind: 'background' as const, jobId: options.startBackground(call) }
      }
      // The runner owns how a thread id reaches the model: it appends the marker
      // to the text, so a background job's collected result carries the id too.
      const { text } = await options.run({ ...call, signal: exec.signal })
      return text
    },
  }
}

/** Whether a tool result is the background handle shape. */
function isBackgroundHandle(value: unknown): value is { jobId: string } {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'background'
    && typeof (value as { jobId?: unknown }).jobId === 'string'
}

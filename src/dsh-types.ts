/**
 * The harness shapes this probe needs, declared locally.
 *
 * The plugin imports nothing from `@deepseek-ai/*` at runtime — that is a
 * deliberate property, so a failure can only mean the wiring and never module
 * resolution. These are structural types mirroring the harness contracts; they
 * are erased at build time.
 *
 * The tool registration shape mirrors what the LCU plugin does, which is the
 * proven path for a plugin that registers its own model-facing tools.
 *
 * @module dsh-subagent-codex-pro/dsh-types
 */

/** A content block on a delegated prompt. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Anything else a prompt may carry; the probe only reads text. */
export interface OtherBlock {
  readonly type: string
}

/** The per-call choices the harness can hand a provider. */
export interface AgentOptionsLike {
  readonly provider?: string
  readonly model?: string
  /** The field `@deepseek-ai/dsh-subagent-codex` has no way to forward. */
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** What one delegation asks for. */
export interface SubagentStartRequestLike {
  readonly prompt: readonly (TextBlock | OtherBlock)[]
  readonly parent: AgentLike
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptionsLike
  /**
   * A JSON Schema the child's answer must conform to, when the tool row carries
   * one and this provider declared the capability for it.
   */
  readonly outputSchema?: Record<string, unknown>
}

/** What a finished run reports. */
export interface SubagentResultLike {
  readonly output: readonly TextBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
}

/** The handle the registry publishes for one child. */
export interface SubagentRunLike {
  readonly id: string
  readonly localAgent: undefined
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

/** The provider contract `ctx.subagents.registerProvider` accepts. */
export interface SubagentProviderLike {
  readonly name: string
  readonly capabilities: {
    readonly agentOptions: boolean
    readonly outputSchema: boolean
    readonly depthLimit: boolean
    readonly toolFilter: boolean
    readonly persona: boolean
  }
  readonly inheritsParentContext: boolean
  start(request: SubagentStartRequestLike): Promise<SubagentRunLike>
}

/**
 * A model-facing tool definition.
 *
 * `parameters` is a whole JSON Schema object (`type: "object"`); the harness
 * rejects a descriptor map with `schema must be a JSON Schema of 'type:
 * "object"'`.
 */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): readonly TextBlock[]
  }
  execute(args: unknown, exec: { readonly signal: AbortSignal }): Promise<unknown>
}

/** The Agent-side registration surface one delegation tool needs. */
export interface AgentLike {
  readonly id: string
  readonly session: { readonly header: { readonly cwd?: string } }
  readonly ctx: {
    readonly tools: { register(definition: ToolDefinitionLike): () => void }
    readonly systemPrompt: {
      section(section: { name: string; order?: number; text: string }): () => void
    }
  }
}

import type { JobOutcomeLike } from './jobs.ts'

/**
 * One background job's specification, as the jobs service accepts it.
 *
 * `run` is called once, when the job starts, and returns the two things the
 * service needs: how to cancel the work, and a promise that settles when it is
 * done. Whatever that promise resolves to becomes the job's output, which
 * `job_output` then reads.
 */
export interface JobSpecLike {
  /** A short category for display, such as `subagent`. */
  readonly kind: string
  /** A human-readable label. */
  readonly label: string
  /** The session that owns the job. */
  readonly owner: string
  run(handle: {
    /** Append one progress chunk to the job's output ring. */
    append(text: string, options?: { channel?: string }): void
    /** Replace the live progress line. */
    updateProgress(line: string): void
  }): {
    cancel(reason?: string): void
    /**
     * Settles with a `JobOutcome` record — `{ status, detail?, result? }` — and
     * must never reject. A bare value here fails validation on every read of the
     * job, not just this one.
     */
    done: Promise<JobOutcomeLike>
  }
}

/** The jobs service. */
export interface JobsServiceLike {
  /**
   * Start one background job.
   *
   * @param spec - the job's identity and its work.
   * @returns the job id the model collects with `job_output`.
   */
  start(spec: JobSpecLike): string
}

/** The slice of the Cordis context this plugin uses. */
export interface Context {
  /** Optional service lookup, as the harness itself uses it. */
  get(service: string): unknown
  on(event: 'agent/created', listener: (payload: { agent: AgentLike; signal: AbortSignal }) => void): () => void
  on(event: 'agent-preset/selected', listener: (sessionId: string, presetId: string) => void): () => void
  readonly logger: {
    info(message: string): void
    warn(message: string): void
  }
  readonly subagents: {
    registerProvider(provider: SubagentProviderLike): () => void
    /** Present in the service contract; used only by the plugin's diagnostics. */
    list?(): string[]
    /** Present in the service contract; used only by the plugin's diagnostics. */
    getProvider?(name: string): unknown
  }
}

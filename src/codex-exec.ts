/**
 * The `codex exec` command line, built and run.
 *
 * This module is deliberately free of harness types: the whole probe rests on
 * whether a plugin can register a subagent provider at all, so the part that
 * talks to Codex stays independently testable. It also keeps the plugin free of
 * runtime dependencies — the failure mode we are looking for is the provider
 * chain, not module resolution.
 *
 * @module dsh-subagent-codex-pro/codex-exec
 */

/** Sandbox levels this runner accepts, matching `codex exec --sandbox`. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Everything one delegation needs. */
export interface CodexExecOptions {
  /** Working directory for the child. */
  readonly cwd: string
  /** The prompt, delivered on stdin. */
  readonly prompt: string
  /** File `codex exec` writes its final message to. */
  readonly outputFile: string
  /** Model id; omitted leaves the CLI's own configuration in charge. */
  readonly model?: string
  /**
   * Reasoning effort, passed as `model_reasoning_effort`.
   *
   * This is the whole point of the probe: the official provider cannot carry it,
   * because it speaks the app-server protocol and never populates the field.
   */
  readonly reasoningEffort?: string
  /** Sandbox mode; omitted leaves the CLI's own configuration in charge. */
  readonly sandbox?: CodexSandboxMode
  /** Skip approvals and sandboxing entirely. Mutually exclusive with `sandbox` in practice. */
  readonly bypassApprovals?: boolean
  /** Extra environment entries layered over the inherited environment. */
  readonly env?: Readonly<Record<string, string>>
}

/** What one run produced. */
export interface CodexExecOutcome {
  /** The child's final message, or its standard output when no file was written. */
  readonly text: string
  /** Exit status, for callers that want to distinguish failure from empty output. */
  readonly code: number | null
  /** Standard error, kept for diagnostics. */
  readonly stderr: string
}

/**
 * Build the argv for one run.
 *
 * The prompt goes on stdin (`-`) rather than argv: delegated prompts are long and
 * routinely contain quotes, newlines, and shell metacharacters.
 *
 * @param options - the run's inputs.
 * @returns the argv to spawn, without the program name.
 */
export function buildCodexExecArgv(options: CodexExecOptions): string[] {
  const argv = ['exec', '-C', options.cwd, '--skip-git-repo-check']
  if (options.model !== undefined && options.model !== '') argv.push('-m', options.model)
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== '') {
    // `-c` overrides a `config.toml` value for this run only, which is how a
    // per-call effort reaches the CLI without touching the user's configuration.
    argv.push('-c', `model_reasoning_effort=${options.reasoningEffort}`)
  }
  if (options.bypassApprovals === true) argv.push('--dangerously-bypass-approvals-and-sandbox')
  else if (options.sandbox !== undefined) argv.push('-s', options.sandbox)
  argv.push('-o', options.outputFile, '-')
  return argv
}

/** The slice of `node:child_process` this module needs, so tests can supply their own. */
export interface SpawnLike {
  (command: string, args: readonly string[], options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: readonly ['pipe', 'pipe', 'pipe']
  }): {
    stdin: { end(data: string): void } | null
    stdout: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null
    stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null
    on(event: 'error', listener: (error: Error) => void): void
    on(event: 'close', listener: (code: number | null) => void): void
    kill(signal?: NodeJS.Signals): boolean
  }
}

/**
 * Run one `codex exec` and collect its final message.
 *
 * @param command - the Codex executable.
 * @param options - the run's inputs, plus the output file to read back.
 * @param spawn - the spawn implementation to use.
 * @param readOutput - reads the output file; returns `undefined` when absent.
 * @returns the child's answer and status.
 */
export async function runCodexExec(
  command: string,
  options: CodexExecOptions,
  spawn: SpawnLike,
  readOutput: (path: string) => string | undefined,
): Promise<CodexExecOutcome> {
  const argv = buildCodexExecArgv(options)
  const child = spawn(command, argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  child.stdin?.end(options.prompt)

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })

  // The output file is the authoritative answer; stdout carries progress lines
  // and is only a fallback when the CLI wrote no file.
  const fromFile = readOutput(options.outputFile)
  const text = fromFile !== undefined && fromFile !== '' ? fromFile : stdout
  return { text, code, stderr }
}

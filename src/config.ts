/** The real Host settings schema. Only native defaults are edited without remounting. */
import z from '@deepseek-ai/schemastery'

/** Schemastery objects/arrays default to empty values; omission here means inheritance. */
function optional(schema: z): z {
  delete schema.meta.default
  return schema
}

// Start from any(): validating an object schema first can strip unknown fields
// in a transform. This callback must be self-contained because the Host sends
// its serialized schema to the browser for the same validation there.
const native = z.transform(z.any(), (value: unknown): unknown => {
  if (value === undefined || value === null) return value
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  const keys = (v: Record<string, unknown>, allowed: string[]): boolean =>
    Object.keys(v).every(key => allowed.includes(key))
  const text = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
    && !v.includes('\0') && new TextEncoder().encode(v).byteLength <= 65536
  if (!object(value) || value.version !== 1 || !keys(value, ['version', 'agents'])) {
    throw new Error('invalid native capability version or fields; review uses subagent_codex_review')
  }
  const agents = value.agents
  if (agents !== undefined) {
    if (!object(agents) || !keys(agents, ['enabled', 'maxConcurrentThreads', 'defaultModel', 'defaultEffort', 'backend'])
      || typeof agents.enabled !== 'boolean') throw new Error('native.agents requires an explicit enabled boolean and known fields')
    if (agents.maxConcurrentThreads !== undefined && (!Number.isSafeInteger(agents.maxConcurrentThreads)
      || Number(agents.maxConcurrentThreads) < 1 || Number(agents.maxConcurrentThreads) >= Number.MAX_SAFE_INTEGER)) {
      throw new Error('native concurrency must be a positive safe integer with room for the root')
    }
    for (const field of ['defaultModel', 'defaultEffort']) {
      if (agents[field] !== undefined && !text(agents[field])) throw new Error('invalid native agents ' + field)
    }
    if (agents.backend !== undefined && agents.backend !== 'v2') throw new Error('invalid native agent backend')
    if (agents.enabled === false && Object.keys(agents).length !== 1) throw new Error('disabled agents cannot have active controls')
  }
  return value
}).description('Native agent defaults. Unset inherits Codex CLI defaults; null explicitly turns agents off. Review is a separate explicit tool.').volatile()

/** Exported as Config by the plugin, so DSH derives an editable live settings form. */
export const ConfigSchema = z.object({
  providerName: z.string(),
  command: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  modelSelection: z.boolean(),
  permissionMode: z.union(['read-only', 'workspace-write', 'never', 'approve-for-me', 'dangerously-bypass-approvals-and-sandbox']),
  env: optional(z.dict(z.string())),
  presets: optional(z.array(z.string())),
  threadMode: z.union(['ephemeral', 'persistent', 'session']),
  runTimeoutMs: z.natural(),
  originator: z.string(),
  native,
})

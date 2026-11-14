/** The real Host settings schema. Only native defaults are edited without remounting. */
import z from '@deepseek-ai/schemastery'

/** Schemastery objects/arrays default to empty values; omission here means inheritance. */
function optional(schema: z): z {
  delete schema.meta.default
  return schema
}

const native = z.union([
  z.const(null),
  optional(z.object({
    version: z.const(1).required(),
    agents: optional(z.object({
      enabled: z.boolean().required(),
      maxConcurrentThreads: z.number().min(1).max(Number.MAX_SAFE_INTEGER - 1).step(1),
      defaultModel: z.string(),
      defaultEffort: z.string(),
      backend: z.const('v2'),
    })),
  })),
]).description('Native agent defaults. Unset inherits Codex CLI defaults; null explicitly turns agents off. Review is a separate explicit tool.').volatile()

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

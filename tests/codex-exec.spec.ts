/**
 * The command line, and one real run through it.
 *
 * The argv cases are pure. The live case spawns the actual Codex CLI with a
 * specific model and reasoning effort, because that is the whole claim the probe
 * rests on: `-m` and `-c model_reasoning_effort=` are how a per-call choice
 * reaches Codex. It skips itself unless `CODEX_SUBAGENT_LIVE=1`, so the default
 * suite stays hermetic and cheap.
 *
 * @module dsh-subagent-codex-pro/tests
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

import { buildCodexExecArgv, runCodexExec } from '../src/codex-exec.ts'

const run = promisify(execFile)

test('the argv carries the model, the effort, and the prompt file', () => {
  const argv = buildCodexExecArgv({
    cwd: '/work',
    prompt: 'ignored here',
    outputFile: '/tmp/out.txt',
    model: 'gpt-6-astra',
    reasoningEffort: 'xhigh',
    sandbox: 'workspace-write',
  })
  assert.deepEqual(argv, [
    'exec', '-C', '/work', '--skip-git-repo-check',
    '-m', 'gpt-6-astra',
    '-c', 'model_reasoning_effort=xhigh',
    '-s', 'workspace-write',
    '-o', '/tmp/out.txt',
    '-',
  ])
  // The prompt travels on stdin, so it can never be mangled by shell quoting.
  assert.equal(argv[argv.length - 1], '-')
})

test('omitted choices leave the CLI its own configuration', () => {
  const argv = buildCodexExecArgv({ cwd: '/w', prompt: 'p', outputFile: '/o.txt' })
  assert.deepEqual(argv, ['exec', '-C', '/w', '--skip-git-repo-check', '-o', '/o.txt', '-'])
  assert.ok(!argv.includes('-m'))
  assert.ok(!argv.some((part) => part.startsWith('model_reasoning_effort')))
})

test('bypassing approvals replaces the sandbox flag rather than doubling it', () => {
  const argv = buildCodexExecArgv({
    cwd: '/w', prompt: 'p', outputFile: '/o.txt',
    sandbox: 'read-only', bypassApprovals: true,
  })
  assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(!argv.includes('-s'))
  assert.ok(!argv.includes('read-only'))
})

test('an empty model or effort is treated as unset', () => {
  const argv = buildCodexExecArgv({ cwd: '/w', prompt: 'p', outputFile: '/o.txt', model: '', reasoningEffort: '' })
  assert.deepEqual(argv, ['exec', '-C', '/w', '--skip-git-repo-check', '-o', '/o.txt', '-'])
})

test('a real run reaches Codex with a chosen model and effort', { skip: process.env.CODEX_SUBAGENT_LIVE !== '1' }, async () => {
  const outputFile = join(tmpdir(), `codex-subagent-live-${String(Date.now())}.txt`)
  const outcome = await runCodexExec(
    'codex',
    {
      cwd: tmpdir(),
      prompt: 'Reply with exactly: PROBE_OK',
      outputFile,
      model: 'gpt-6-astra',
      reasoningEffort: 'xhigh',
      bypassApprovals: true,
    },
    spawn as unknown as Parameters<typeof runCodexExec>[2],
    (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  )
  rmSync(outputFile, { force: true })
  assert.equal(outcome.code, 0, `codex exited ${String(outcome.code)}: ${outcome.stderr.slice(-400)}`)
  assert.match(outcome.text, /PROBE_OK/)
})

test('the codex CLI this probe depends on is present', async () => {
  // Cheap precondition so a missing CLI reads as a missing CLI.
  const { stdout } = await run('codex', ['--version'])
  assert.match(stdout.trim(), /\d+\.\d+\.\d+/)
})

test('the tool exposes model and effort only while the host opts in', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const base = {
    cwd: '/w',
    run: async () => 'unused',
  }
  const off = createCodexTool({ ...base, modelSelectionEnabled: false })
  const on = createCodexTool({ ...base, modelSelectionEnabled: true })
  const props = (tool: { parameters: Record<string, unknown> }): string[] =>
    Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)

  assert.deepEqual(props(off), ['description', 'prompt'])
  assert.deepEqual(props(on), ['description', 'prompt', 'model', 'reasoning_effort'])
  // The harness rejects a descriptor map: `parameters` must be a JSON Schema object.
  for (const tool of [off, on]) {
    assert.equal((tool.parameters as { type?: string }).type, 'object')
    assert.equal(typeof tool.parameters, 'object')
  }
})

test('the tool forwards the call\'s model and effort to the runner', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const seen: { prompt: string; model?: string; reasoningEffort?: string }[] = []
  const tool = createCodexTool({
    cwd: '/w',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'medium',
    modelSelectionEnabled: true,
    run: async (request) => {
      seen.push(request)
      return 'DONE'
    },
  })
  const result = await tool.execute(
    { description: 'probe', prompt: 'say hi', model: 'gpt-6-astra', reasoning_effort: 'xhigh' },
    { signal: new AbortController().signal },
  )
  assert.equal(result, 'DONE')
  const pick = (r: { prompt: string; model?: string; reasoningEffort?: string }) =>
    ({ prompt: r.prompt, model: r.model, reasoningEffort: r.reasoningEffort })
  assert.deepEqual(pick(seen[0]!), { prompt: 'say hi', model: 'gpt-6-astra', reasoningEffort: 'xhigh' })

  // Omitted choices fall back to the configured defaults.
  await tool.execute({ description: 'probe', prompt: 'again' }, { signal: new AbortController().signal })
  assert.deepEqual(pick(seen[1]!), { prompt: 'again', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })

  await assert.rejects(
    async () => tool.execute({ description: 'probe', prompt: '' }, { signal: new AbortController().signal }),
    /prompt.*required/,
  )
})

test('run_in_background appears only when the jobs service is present', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const base = {
    cwd: '/w',
    modelSelectionEnabled: true,
    run: async () => 'foreground',
    startBackground: () => 'job-1',
  }
  const props = (tool: { parameters: Record<string, unknown> }): string[] =>
    Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)

  assert.deepEqual(props(createCodexTool({ ...base, backgroundEnabled: false })),
    ['description', 'prompt', 'model', 'reasoning_effort'])
  assert.deepEqual(props(createCodexTool({ ...base, backgroundEnabled: true })),
    ['description', 'prompt', 'model', 'reasoning_effort', 'run_in_background'])

  // Without background support the output is a plain answer, so the schema stays simple.
  const off = createCodexTool({ ...base, backgroundEnabled: false })
  const on = createCodexTool({ ...base, backgroundEnabled: true })
  assert.deepEqual(off.output.schema, { type: 'string' })
  assert.ok(Array.isArray((on.output.schema as { oneOf?: unknown[] }).oneOf))
})

test('a background call returns its job id and never calls the foreground runner', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const ran: string[] = []
  const started: { label: string; prompt: string; model?: string; reasoningEffort?: string }[] = []
  const tool = createCodexTool({
    cwd: '/w',
    modelSelectionEnabled: true,
    backgroundEnabled: true,
    model: 'gpt-6.1-sol',
    run: async (request) => { ran.push(request.prompt); return 'foreground' },
    startBackground: (request) => {
      started.push({ label: request.label, prompt: request.prompt, model: request.model, reasoningEffort: request.reasoningEffort })
      return 'job-42'
    },
  })
  const background = await tool.execute(
    { description: 'long job', prompt: 'do the thing', model: 'gpt-6-astra', reasoning_effort: 'xhigh', run_in_background: true },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(background, { kind: 'background', jobId: 'job-42' })
  assert.deepEqual(ran, [])
  assert.deepEqual(started, [{ label: 'long job', prompt: 'do the thing', model: 'gpt-6-astra', reasoningEffort: 'xhigh' }])
  // The renderer turns the handle into something a model can act on.
  const rendered = tool.output.render({}, background)
  assert.match(rendered[0]!.text, /background job job-42/)

  // Foreground still works, and still resolves against the configured defaults.
  const foreground = await tool.execute(
    { description: 'quick', prompt: 'do it now' },
    { signal: new AbortController().signal },
  )
  assert.equal(foreground, 'foreground')
  assert.deepEqual(ran, ['do it now'])
})

test('a background delegation settles with a job outcome, never a bare value', async () => {
  const { settleJob } = await import('../src/jobs.ts')
  // Success: the delegation's text becomes `result`, which the model reads back.
  assert.deepEqual(await settleJob(Promise.resolve('PROBE_OK')), { status: 'completed', result: 'PROBE_OK' })
  // Failure must still settle, because `done` is not allowed to reject.
  const failed = await settleJob(Promise.reject(new Error('codex exited 3')))
  assert.equal(failed.status, 'failed')
  assert.match(failed.detail ?? '', /codex exited 3/)
  // The record is lossless JSON, which is what the registry validates.
  assert.equal(JSON.stringify(await settleJob(Promise.resolve('x'))), '{"status":"completed","result":"x"}')
})

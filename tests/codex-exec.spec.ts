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

  assert.deepEqual(props(off), ['description', 'prompt', 'cwd'])
  assert.deepEqual(props(on), ['description', 'prompt', 'cwd', 'model', 'reasoning_effort'])
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
      return { text: 'DONE', threadId: undefined }
    },
  })
  const result = await tool.execute(
    { description: 'probe', prompt: 'say hi', model: 'gpt-6-astra', reasoning_effort: 'xhigh' },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(result, { content: [{ type: 'text', text: 'DONE' }] })
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
    run: async () => ({ text: 'foreground', threadId: undefined }),
    startBackground: () => 'job-1',
  }
  const props = (tool: { parameters: Record<string, unknown> }): string[] =>
    Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)

  assert.deepEqual(props(createCodexTool({ ...base, backgroundEnabled: false })),
    ['description', 'prompt', 'cwd', 'model', 'reasoning_effort'])
  assert.deepEqual(props(createCodexTool({ ...base, backgroundEnabled: true })),
    ['description', 'prompt', 'cwd', 'model', 'reasoning_effort', 'run_in_background'])

  // Without background support the output is a plain answer, so the schema stays simple.
  const off = createCodexTool({ ...base, backgroundEnabled: false })
  const on = createCodexTool({ ...base, backgroundEnabled: true })
  const foregroundSchema = off.output.schema as { properties?: { content?: { type?: string } } }
  // A foreground answer is content blocks, so an image a run produced can be
  // delivered as an image rather than as a description of one.
  assert.equal(foregroundSchema.properties?.content?.type, 'array')
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
    run: async (request) => { ran.push(request.prompt); return { text: 'foreground', threadId: undefined } },
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
  assert.deepEqual(foreground, { content: [{ type: 'text', text: 'foreground' }] })
  assert.deepEqual(ran, ['do it now'])
})

test('a background delegation settles with a job outcome, never a bare value', async () => {
  const { settleJob } = await import('../src/jobs.ts')
  // Success: the delegation's text becomes `result`, which the model reads back.
  assert.deepEqual(await settleJob(Promise.resolve({ text: 'PROBE_OK', threadId: undefined })), { status: 'completed', result: 'PROBE_OK' })
  // Failure must still settle, because `done` is not allowed to reject.
  const failed = await settleJob(Promise.reject(new Error('codex exited 3')))
  assert.equal(failed.status, 'failed')
  assert.match(failed.detail ?? '', /codex exited 3/)
  // The record is lossless JSON, which is what the registry validates.
  assert.equal(JSON.stringify(await settleJob(Promise.resolve({ text: 'x', threadId: undefined }))), '{"status":"completed","result":"x"}')
})

test('the tool declares and forwards the thread controls when enabled', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const seen: { threadMode?: string; threadId?: string }[] = []
  const make = (threadControlEnabled: boolean) => createCodexTool({
    cwd: '/w',
    modelSelectionEnabled: true,
    backgroundEnabled: false,
    defaultThreadMode: 'session',
    threadControlEnabled,
    run: async (request) => {
      seen.push({ threadMode: request.threadMode, threadId: request.threadId })
      return { text: 'DONE', threadId: 'thread-3' }
    },
  })
  const props = (tool: { parameters: Record<string, unknown> }): string[] =>
    Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)

  // disabled: the schema is exactly what it was before this feature existed
  assert.deepEqual(props(make(false)), ['description', 'prompt', 'cwd', 'model', 'reasoning_effort'])
  assert.deepEqual(props(make(true)), ['description', 'prompt', 'cwd', 'model', 'reasoning_effort', 'thread_mode', 'thread_id'])

  const tool = make(true)
  await tool.execute(
    { description: 'probe', prompt: 'go', thread_mode: 'persistent', thread_id: 'thread-1' },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(seen, [{ threadMode: 'persistent', threadId: 'thread-1' }])

  // An unknown mode is not forwarded as a mode; the runner falls back to config.
  seen.length = 0
  await tool.execute(
    { description: 'probe', prompt: 'go', thread_mode: 'nonsense' },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(seen, [{ threadMode: undefined, threadId: undefined }])
})

test('the tool describes the thread default it was configured with', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const described = (defaultThreadMode: 'ephemeral' | 'persistent' | 'session') => createCodexTool({
    cwd: '/w',
    modelSelectionEnabled: false,
    backgroundEnabled: false,
    defaultThreadMode,
    threadControlEnabled: true,
    run: async () => ({ text: 'x', threadId: undefined }),
  }).description as string

  assert.match(described('session'), /`session` by default/)
  assert.match(described('persistent'), /`persistent` by default/)
  assert.match(described('session'), /thread_id/)
})

test('image blocks from the runner reach the tool result and its rendering', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const tool = createCodexTool({
    cwd: '/w',
    modelSelectionEnabled: false,
    backgroundEnabled: false,
    defaultThreadMode: 'ephemeral',
    threadControlEnabled: false,
    // A runner that reports a thread and one delivered image, the shape
    // index.ts produces once the attachment store has taken the bytes.
    run: async () => ({
      text: 'shot taken',
      threadId: 'thread-1',
      blocks: [
        { type: 'text', text: 'shot taken' },
        { type: 'image', attachment: 'att-1' },
      ],
    }),
  })
  const result = await tool.execute(
    { description: 'shot', prompt: 'take one' },
    { signal: new AbortController().signal },
  ) as { content: { type: string, attachment?: unknown }[] }

  assert.equal(result.content.length, 2)
  assert.equal(result.content[1]?.type, 'image')
  assert.equal(result.content[1]?.attachment, 'att-1')

  // The model-facing text stays text. A background call reads only this, which
  // is why the runner puts the image's location in the text as well.
  const rendered = tool.output.render({}, result) as { type: string, text: string }[]
  assert.equal(rendered[0]?.text, 'shot taken')
})

test('a text-only runner still returns a content block the schema admits', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const tool = createCodexTool({
    cwd: '/w',
    modelSelectionEnabled: false,
    backgroundEnabled: false,
    defaultThreadMode: 'ephemeral',
    threadControlEnabled: false,
    run: async () => ({ text: 'plain', threadId: undefined }),
  })
  const result = await tool.execute(
    { description: 'p', prompt: 'go' },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(result, { content: [{ type: 'text', text: 'plain' }] })
  const rendered = tool.output.render({}, result) as { text: string }[]
  assert.equal(rendered[0]?.text, 'plain')
})

test('the tool forwards a caller-named working directory to the runner', async () => {
  const { createCodexTool } = await import('../src/tool.ts')
  const seen: (string | undefined)[] = []
  const tool = createCodexTool({
    cwd: '/session',
    modelSelectionEnabled: false,
    backgroundEnabled: false,
    defaultThreadMode: 'ephemeral',
    threadControlEnabled: false,
    run: async (request) => {
      seen.push(request.cwd)
      return { text: 'ok', threadId: undefined }
    },
  })
  await tool.execute({ description: 'x', prompt: 'go' }, { signal: new AbortController().signal })
  await tool.execute(
    { description: 'x', prompt: 'go', cwd: '/tmp/smoke' },
    { signal: new AbortController().signal },
  )
  // Omitted stays undefined, so the plugin's own default survives; named is
  // forwarded verbatim for the plugin to validate.
  assert.deepEqual(seen, [undefined, '/tmp/smoke'])
  assert.ok(
    Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties).includes('cwd'),
    'cwd must be declared, or the model cannot pass it',
  )
})

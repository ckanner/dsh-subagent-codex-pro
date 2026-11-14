import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config, CodexExecProvider, type Config as PluginConfig } from '../src/index.ts'
import { readNativeDefault } from '../src/desktop-native.ts'
import type { ToolDefinitionLike, JobSpecLike } from '../src/dsh-types.ts'

const signal = () => new AbortController().signal
const enabled = { version: 1 as const, agents: { enabled: true, maxConcurrentThreads: 2,
  defaultModel: 'child-model', defaultEffort: 'low', backend: 'v2' as const } }

function harness(t: { after(fn: () => void): void }, extra: PluginConfig = {}, mode = 'success', background = false) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'codex-desktop-native-')))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const command = join(cwd, 'codex.mjs'), capture = join(cwd, 'rpc.jsonl')
  copyFileSync(fileURLToPath(new URL('./fixtures/machine-server.mjs', import.meta.url)), command)
  chmodSync(command, 0o755)
  const registered = new Map<string, ToolDefinitionLike>()
  const listeners = new Map<string, Function>()
  const jobs: ReturnType<JobSpecLike['run']>[] = []
  let provider: CodexExecProvider
  const agent = { id: 'desktop-agent', session: { header: { cwd, agentPreset: 'test' } },
    ctx: { tools: { register(tool: ToolDefinitionLike) { registered.set(tool.name, tool); return () => {} } },
      systemPrompt: { section() { return () => {} } } } }
  const context = {
    get(name: string) {
      if (name === 'jobs' && background) return { start(spec: JobSpecLike) {
        jobs.push(spec.run({ append() {}, updateProgress() {} })); return 'job-' + jobs.length
      } }
      return undefined
    },
    on(name: string, callback: Function) { listeners.set(name, callback); return () => {} },
    logger: { info() {}, warn() {} },
    subagents: { registerProvider(value: CodexExecProvider) { provider = value; return () => {} } },
  }
  apply(context as never, { command, presets: ['test'], model: 'test-model', reasoningEffort: 'high',
    permissionMode: 'workspace-write', runTimeoutMs: 5000,
    env: { FAKE_MACHINE_MODE: mode, FAKE_MACHINE_CAPTURE: capture }, ...extra })
  listeners.get('agent/created')!({ agent, signal: signal() })
  assert.ok(registered.has('subagent_codex'))
  assert.ok(registered.has('subagent_codex_review'))
  const messages = () => existsSync(capture)
    ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const call = (args: object = {}, name = 'subagent_codex') =>
    registered.get(name)!.execute({ description: 'fixture task', ...(name === 'subagent_codex' ? { prompt: 'Return the fixture answer.' } : {}), ...args }, { signal: signal() }) as Promise<any>
  return { cwd, agent, registered, provider: provider!, jobs, messages, call }
}

test('real Config schema preserves absent/null inheritance and rejects unknown native controls at invocation', () => {
  const omitted = Config({})
  assert.equal(typeof omitted.native.get, 'function')
  assert.equal(readNativeDefault(omitted.native), undefined)
  assert.deepEqual(readNativeDefault(Config({ native: null }).native), { version: 1, agents: { enabled: false } })
  assert.deepEqual(readNativeDefault(Config({ native: enabled }).native), enabled)
  assert.throws(() => readNativeDefault(Config({ native: { version: 1, unknownSwitch: true } }).native), /fields/)
  assert.throws(() => readNativeDefault({ version: 1, review: { target: { type: 'uncommittedChanges' } } }), /subagent_codex_review/)
})

test('actual registered desktop/PTC tool forwards live settings through argv, config/read and thread/start', async t => {
  let setting: any = enabled
  const h = harness(t, { native: { get: () => setting } })
  const first = await h.call({ output_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } })
  assert.equal(first.content[0].text, '{"message":"MACHINE_OK"}')
  assert.deepEqual(first.native.requested, enabled)
  assert.equal(first.native.effective.matched, true)
  let start = h.messages().filter(m => m.method === 'thread/start').at(-1)
  assert.equal(start.params.config['agents.default_subagent_model'], 'child-model')
  assert.equal(start.params.config['agents.default_subagent_reasoning_effort'], 'low')
  assert.equal(start.params.config['agents.max_concurrent_threads_per_session'], 2)
  assert.deepEqual(start.params.config['features.multi_agent_v2'], { enabled: true, disable_native_tools: false, max_concurrent_threads_per_session: 3 })
  assert.equal(h.messages().filter(m => m.method === 'turn/start').at(-1).params.effort, 'high')
  setting = null
  const off = await h.call()
  assert.deepEqual(off.native.requested, { version: 1, agents: { enabled: false } })
  start = h.messages().filter(m => m.method === 'thread/start').at(-1)
  assert.deepEqual(start.params.config, { 'agents.enabled': false, 'features.multi_agent_v2': false })
  setting = undefined
  const reads = h.messages().filter(m => m.method === 'config/read').length
  const inherited = await h.call()
  assert.equal(inherited.native, undefined)
  assert.equal(h.messages().filter(m => m.method === 'config/read').length, reads)
  assert.equal(h.messages().filter(m => m.method === 'thread/start').at(-1).params.config, undefined)
})

test('single-call native objects replace defaults and explicit off never retains active controls', async t => {
  const h = harness(t, { native: enabled })
  const smaller = await h.call({ native: { version: 1, agents: { enabled: true, maxConcurrentThreads: 1 } } })
  assert.deepEqual(smaller.native.requested, { version: 1, agents: { enabled: true, maxConcurrentThreads: 1 } })
  assert.deepEqual(h.messages().filter(m => m.method === 'thread/start').at(-1).params.config,
    { 'agents.enabled': true, 'agents.max_concurrent_threads_per_session': 1 })
  for (const native of [null, { version: 1, agents: { enabled: false } }]) {
    const result = await h.call({ native })
    assert.deepEqual(result.native.requested, { version: 1, agents: { enabled: false } })
    assert.deepEqual(h.messages().filter(m => m.method === 'thread/start').at(-1).params.config,
      { 'agents.enabled': false, 'features.multi_agent_v2': false })
  }
})

test('model selection policy preserves configured child defaults but forbids caller changes or implicit clearing', async t => {
  const h = harness(t, { native: enabled, modelSelection: false })
  assert.equal((await h.call()).native.requested.agents.defaultModel, 'child-model')
  await h.call({ native: { ...enabled, agents: { ...enabled.agents, maxConcurrentThreads: 1 } } })
  for (const args of [
    { model: 'other-model' }, { reasoning_effort: 'max' },
    { native: { version: 1, agents: { enabled: true } } },
    { native: { ...enabled, agents: { ...enabled.agents, defaultModel: 'other-child' } } },
  ]) {
    const before = h.messages().length
    await assert.rejects(h.call(args), /unsupported argument|modelSelection/)
    assert.equal(h.messages().length, before)
  }
  assert.equal((await h.call({ native: null })).native.requested.agents.enabled, false)
})

test('unknown fields, disabled residuals and permission widening fail before a process starts', async t => {
  const h = harness(t, { permissionMode: 'read-only' })
  for (const args of [
    { unexpected: true }, { native: { version: 1, typo: true } },
    { native: { version: 1, agents: { enabled: true, maxConcurrency: 2 } } },
    { native: { version: 1, agents: { enabled: false, backend: 'v2' } } },
    { native: { version: 1, review: { target: { type: 'uncommittedChanges' } } } },
    { permission_mode: 'workspace-write' }, { run_in_background: true },
  ]) await assert.rejects(h.call(args))
  assert.deepEqual(h.messages(), [])
})

test('Host provider uses the same live defaults and refuses invented provider options', async t => {
  let setting: any = enabled
  const h = harness(t, { native: { get: () => setting } }, 'native-child')
  const request = { parent: h.agent as never, prompt: [{ type: 'text', text: 'fixture' }], cwd: h.cwd, signal: signal() }
  const first = await h.provider.start(request)
  const outcome = await first.result
  assert.equal(outcome.stopReason, 'completed')
  const summary = JSON.parse(outcome.diagnostic!).native
  assert.equal(summary.effectiveMatched, true)
  assert.equal(summary.completion.confirmed, true)
  assert.equal(summary.children.count, 1)
  assert.equal(summary.usage.totalTokens, 50)
  assert.ok(Buffer.byteLength(outcome.diagnostic!) <= 4096)
  await first.dispose()
  setting = null
  const off = await h.provider.start({ ...request, signal: signal() })
  assert.equal((await off.result).stopReason, 'completed')
  assert.deepEqual(h.messages().filter(m => m.method === 'thread/start').at(-1).params.config,
    { 'agents.enabled': false, 'features.multi_agent_v2': false })
  await off.dispose()
  const before = h.messages().length
  await assert.rejects(h.provider.start({ ...request, native: enabled } as never), /unsupported Host start field/)
  await assert.rejects(h.provider.start({ ...request, agentOptions: { native: enabled } } as never), /unsupported agentOptions/)
  assert.equal(h.messages().length, before)
})

test('implicit session reuse changes with live native binding while verified external resume remains available', async t => {
  let setting: any = null
  const h = harness(t, { native: { get: () => setting }, threadMode: 'session' })
  await h.call()
  await h.call()
  setting = enabled
  await h.call()
  await h.call()
  await h.call({ thread_id: 'external-thread', native: null })
  assert.deepEqual(h.messages().filter(m => ['thread/start', 'thread/resume'].includes(m.method)).map(m => m.method),
    ['thread/start', 'thread/resume', 'thread/start', 'thread/resume', 'thread/resume'])
  const resume = h.messages().filter(m => m.method === 'thread/resume').at(-1)
  assert.equal(resume.params.threadId, 'external-thread')
  assert.deepEqual(resume.params.config, { 'agents.enabled': false, 'features.multi_agent_v2': false })
})

test('dedicated native review is fresh, read-only, explicit and independent from delegation defaults', async t => {
  const h = harness(t, { native: enabled, threadMode: 'session' })
  const target = { type: 'baseBranch', branch: 'main' }
  const result = await h.call({ target }, 'subagent_codex_review')
  assert.equal(result.content[0].text, 'NATIVE_REVIEW_OK')
  assert.deepEqual(result.native.requested, { version: 1, agents: { enabled: false }, review: { target } })
  const start = h.messages().find(m => m.method === 'thread/start')
  assert.equal(start.params.ephemeral, true)
  assert.equal(start.params.sandbox, 'read-only')
  assert.equal(start.params.approvalPolicy, 'never')
  assert.equal(start.params.config.review_model, 'test-model')
  assert.equal(start.params.config.model_reasoning_effort, 'high')
  assert.deepEqual(h.messages().find(m => m.method === 'review/start').params.target, target)
  assert.equal(h.messages().some(m => m.method === 'turn/start' || m.method === 'thread/resume'), false)
  const before = h.messages().length
  for (const extra of [{ prompt: 'ignored?' }, { output_schema: { type: 'object' } }, { thread_id: 'old' }, { native: enabled }, { images: ['/tmp/image.png'] }]) {
    await assert.rejects(h.call({ target, ...extra }, 'subagent_codex_review'), /unsupported argument/)
  }
  assert.equal(h.messages().length, before)
})

test('full child evidence survives direct and background tools without changing structured answer text', async t => {
  const h = harness(t, { native: enabled }, 'native-child', true)
  const direct = await h.call()
  assert.equal(direct.content[0].text, '{"message":"MACHINE_OK"}')
  assert.equal(direct.native.children[0].id, 'child-1')
  assert.equal(direct.native.usage.totalTokens, 50)
  const rendered = h.registered.get('subagent_codex')!.output.render({}, direct)
  assert.equal(rendered[0].type, 'text')
  assert.equal(JSON.parse((rendered[0] as any).text).message, 'MACHINE_OK')
  assert.equal(JSON.parse((rendered[1] as any).text).native.children.count, 1)
  await h.call({ run_in_background: true })
  const job = await h.jobs[0]!.done
  assert.equal(job.status, 'completed')
  const evidence = JSON.parse(job.result!)
  assert.equal(evidence.text, '{"message":"MACHINE_OK"}')
  assert.equal(evidence.native.children[0].state, 'completed')
})

test('pending native children cannot produce success and their evidence survives failed job settlement', async t => {
  const h = harness(t, { native: enabled }, 'native-child-pending', true)
  await assert.rejects(h.call(), (error: any) => {
    assert.equal(error.outcome.stopReason, 'error')
    assert.equal(error.outcome.native.completion.confirmed, false)
    assert.deepEqual(error.outcome.native.completion.pendingIds, ['child-1'])
    assert.equal(error.outcome.native.cleanup.confirmed, true)
    assert.match(error.message, /native.*completion/)
    return true
  })
  await h.call({ run_in_background: true })
  const job = await h.jobs[0]!.done
  assert.equal(job.status, 'failed')
  assert.deepEqual(JSON.parse(job.result!).native.completion.pendingIds, ['child-1'])
})

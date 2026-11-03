import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { parseMachineRequest, runMachine, type MachineRequest } from '../src/machine.ts'
import { CodexExecProvider, resolvePermissionOverride } from '../src/index.ts'

function fixture(t: { after(fn: () => void): void }): { dir: string; command: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-machine-contract-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const command = join(dir, 'fake-codex.mjs')
  copyFileSync(fileURLToPath(new URL('./fixtures/machine-server.mjs', import.meta.url)), command)
  chmodSync(command, 0o755)
  return { dir, command }
}
function request(dir: string, command: string): MachineRequest {
  return { protocol: 1, requestId: 'caller-123', prompt: 'Return the fixture response.', cwd: dir,
    model: 'test-model', effort: 'high', permissionMode: 'workspace-write', command, timeoutMs: 5000 }
}

test('machine input rejects unknown fields and ambiguous permissions before spawning', () => {
  const base = request('/tmp', 'never-start-this-command')
  for (const invalid of [
    { ...base, protocol: 2 }, { ...base, permissionMode: 'never' }, { ...base, cwd: 'relative' },
    { ...base, maxTokens: 12 }, { ...base, timeoutMs: Infinity }, { ...base, maxOutputBytes: 0 },
    { ...base, threadMode: 'ephemeral', threadId: 'old-thread' }, { ...base, images: ['relative.png'] },
    { ...base, permissionMode: ['workspace-write'] }, { ...base, threadMode: ['ephemeral'] },
    { ...base, permissionMode: {} }, { ...base, threadMode: {} },
  ]) assert.throws(() => parseMachineRequest(invalid), { name: 'MachineInputError' })
})

test('model-facing permission overrides cannot expand the configured boundary', () => {
  assert.equal(resolvePermissionOverride('workspace-write', undefined), 'workspace-write')
  assert.equal(resolvePermissionOverride('workspace-write', 'read-only'), 'read-only')
  assert.equal(resolvePermissionOverride('dangerously-bypass-approvals-and-sandbox', 'workspace-write'), 'workspace-write')
  assert.throws(() => resolvePermissionOverride('read-only', 'workspace-write'), /exceeds/)
  assert.throws(() => resolvePermissionOverride('workspace-write', 'dangerously-bypass-approvals-and-sandbox'), /exceeds/)
  assert.throws(() => resolvePermissionOverride('workspace-write', 'never'), /exceeds/)
})

test('public machine receipt preserves real configuration, usage, identity and structured output', async (t) => {
  const { dir, command } = fixture(t)
  const input = { ...request(dir, command), outputSchema: { type: 'object', required: ['message'],
    properties: { message: { type: 'string' } }, additionalProperties: false } }
  const result = await runMachine(input)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.protocol, 1)
  assert.equal(result.requestId, 'caller-123')
  assert.equal(result.runId, result.outcome?.execution.runId)
  assert.equal(result.outcome?.execution.threadId, 'machine-thread')
  assert.equal(result.outcome?.execution.turnId, 'machine-turn')
  assert.equal(result.outcome?.configuration?.matched, true)
  assert.equal(result.outcome?.configuration?.effective.model, 'test-model')
  assert.equal(result.outcome?.cleanup.confirmed, true)
  assert.deepEqual(result.outcome?.structured, { message: 'MACHINE_OK' })
  assert.equal(result.outcome?.usage.run?.totalTokens, 140)
  assert.equal(result.costUSD, null)
  assert.equal(result.costStatus, 'unknown')
  assert.equal(result.outcome?.execution.timedOut, false)
  assert.equal(result.outcome?.execution.cancelled, false)
})

test('startup configuration failures remain machine-readable and never send the task', async (t) => {
  const { dir, command } = fixture(t)
  for (const mode of ['missing-model', 'wrong-model']) {
    const capture = join(dir, mode + '.jsonl')
    const result = await runMachine(request(dir, command), {
      env: { FAKE_MACHINE_MODE: mode, FAKE_MACHINE_CAPTURE: capture },
    })
    assert.equal(result.ok, false)
    assert.equal(result.failure?.stage, 'thread-start')
    assert.equal(result.failure?.configuration?.matched, false)
    assert.equal(result.failure?.cleanup?.confirmed, true)
    const messages = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(messages.some((message) => message.method === 'turn/start'), false)
  }
})

test('startup failure receipts retain the bounded cause', async (t) => {
  const { dir, command } = fixture(t)
  const result = await runMachine(request(dir, command), {
    env: { FAKE_MACHINE_MODE: 'wrong-ephemeral' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure?.stage, 'thread-start')
  assert.match(result.failure?.diagnostic ?? '', /ephemeral|persistent/i)
})

test('bad usage following a valid snapshot is not represented as complete', async (t) => {
  const { dir, command } = fixture(t)
  const result = await runMachine(request(dir, command), { env: { FAKE_MACHINE_MODE: 'bad-usage' } })
  assert.equal(result.ok, true)
  assert.notEqual(result.outcome?.usage.status, 'complete')
})

test('machine cancellation before startup reports cancellation without a fabricated process exit', async (t) => {
  const { dir, command } = fixture(t)
  const controller = new AbortController()
  controller.abort()
  const result = await runMachine(request(dir, command), { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.failure?.category, 'aborted')
  assert.equal(result.failure?.execution?.exitCode, null)
})

test('DSH provider declares the real Host capability fields and refuses unsupported overrides', async () => {
  const provider = new CodexExecProvider({ providerName: 'codex-pro', command: 'must-not-spawn', permissionMode: 'read-only' })
  assert.deepEqual(provider.capabilities, { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false })
  for (const agentOptions of [{ provider: 'another-llm' }, { maxTokens: 100 }]) {
    await assert.rejects(provider.start({ prompt: [{ type: 'text', text: 'must not run' }],
      cwd: '/tmp', parent: { session: { header: { cwd: '/tmp' } } } as never,
      signal: new AbortController().signal, agentOptions }), /provider and maxTokens overrides/)
  }
})

test('DSH provider preserves a clean structured answer and bounded metadata diagnostic', async (t) => {
  const { dir, command } = fixture(t)
  const provider = new CodexExecProvider({ providerName: 'codex-pro', command, permissionMode: 'read-only', model: 'test-model' })
  const run = await provider.start({ prompt: [{ type: 'text', text: 'PRIVATE_PROMPT_DO_NOT_DIAGNOSE' }],
    cwd: dir, parent: { session: { header: { cwd: dir } } } as never,
    signal: new AbortController().signal,
    outputSchema: { type: 'object', required: ['not-present'] },
  })
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic ?? '', /structured output/)
  assert.equal((result.diagnostic ?? '').includes('PRIVATE_PROMPT'), false)
  assert.equal((result.diagnostic ?? '').includes(dir), false)
  assert.ok(Buffer.byteLength(result.diagnostic ?? '') <= 4096)
  await run.dispose()
})

test('the provider keeps a bounded approval diagnostic from an unattended decision', async (t) => {
  const { dir, command } = fixture(t)
  const provider = new CodexExecProvider({
    providerName: 'codex-pro-approval-test', command, permissionMode: 'read-only', model: 'test-model',
    env: { FAKE_MACHINE_MODE: 'declined' },
  })
  const run = await provider.start({
    prompt: [{ type: 'text', text: 'approval diagnostic probe' }],
    cwd: dir,
    parent: { session: { header: { cwd: dir } } } as never,
    signal: new AbortController().signal,
  })
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.match(result.diagnostic ?? '', /Codex unattended decision/)
  assert.match(result.diagnostic ?? '', /command approval/)
  assert.equal((result.diagnostic ?? '').includes('approval diagnostic probe'), false)
  await run.dispose()
})

test('CLI treats a consumer-closed stdout as a quiet non-zero exit', { timeout: 20_000 }, async (t) => {
  const { dir, command } = fixture(t)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/machine-cli.ts', import.meta.url)), '--json'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_MACHINE_MODE: 'large-final' },
  })
  t.after(() => { child.kill('SIGKILL') })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  child.stdin.end(JSON.stringify({ ...request(dir, command), timeoutMs: 10_000 }))
  setTimeout(() => { child.stdout.destroy() }, 50)
  assert.equal(await exited, 1)
})

test('CLI invalid input is a single bounded error envelope and does not echo task data', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/machine-cli.ts', import.meta.url))], {
    input: '{"prompt":"PRIVATE_INPUT" broken', encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 2)
  const error = JSON.parse(result.stdout)
  assert.equal(error.protocol, 1)
  assert.equal(error.type, 'error')
  assert.equal(error.error.code, 'INVALID_REQUEST')
  assert.equal(result.stdout.includes('PRIVATE_INPUT'), false)
})

test('CLI SIGTERM waits for app-server cleanup and records caller cancellation', { timeout: 20_000 }, async (t) => {
  const { dir, command } = fixture(t)
  const capture = join(dir, 'cancel.jsonl')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/machine-cli.ts', import.meta.url)), '--json'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_MACHINE_MODE: 'turn-hang', FAKE_MACHINE_CAPTURE: capture },
  })
  t.after(() => { child.kill('SIGKILL') })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  child.stdin.end(JSON.stringify({ ...request(dir, command), timeoutMs: 15_000 }))
  const until = Date.now() + 5000
  let ready = false
  while (Date.now() < until && !ready) {
    try { ready = readFileSync(capture, 'utf8').includes('turn/start') } catch { /* not started yet */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(ready, true, stderr)
  child.kill('SIGTERM')
  assert.equal(await closed, 143, stderr)
  const receipt = JSON.parse(stdout)
  assert.equal(receipt.ok, false)
  assert.equal(receipt.requestId, 'caller-123')
  assert.equal(receipt.outcome.execution.cancelled, true)
  assert.equal(receipt.outcome.execution.timedOut, false)
  assert.equal(receipt.outcome.cleanup.confirmed, true)
})

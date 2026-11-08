import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import {
  MACHINE_LIFECYCLE_CAPABILITIES, MACHINE_LIFECYCLE_VERSION, recoverMachine, runMachine,
  type MachineLifecycleEvent, type MachineRequest,
} from '../src/machine.ts'

const source = fileURLToPath(new URL('../src/machine.ts', import.meta.url))
const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })
async function until(check: () => boolean, description: string, milliseconds = 10_000): Promise<void> {
  const end = Date.now() + milliseconds
  while (!check()) { if (Date.now() >= end) throw new Error('timed out: ' + description); await delay(20) }
}
function fixture(t: { after(fn: () => void): void }): { dir: string; request: MachineRequest; capture: string; journal: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-recovery-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const command = join(dir, 'fake-codex.mjs')
  copyFileSync(fileURLToPath(new URL('./fixtures/machine-server.mjs', import.meta.url)), command)
  chmodSync(command, 0o755)
  return { dir, capture: join(dir, 'capture.jsonl'), journal: join(dir, 'journal'),
    request: { protocol: 1, requestId: 'durable-attempt-1', prompt: 'SECRET_PROMPT_NOT_IN_CHECKPOINT', cwd: dir,
      model: 'test-model', effort: 'high', permissionMode: 'workspace-write', command, timeoutMs: 8_000, threadMode: 'persistent' } }
}
function turns(capture: string): number {
  if (!existsSync(capture)) return 0
  return readFileSync(capture, 'utf8').split('\n').filter(line => line.includes('"method":"turn/start"')).length
}

test('lifecycle capabilities are explicit and each pre-dispatch checkpoint awaits durable acknowledgement', async t => {
  const { request, capture, journal } = fixture(t)
  assert.equal(MACHINE_LIFECYCLE_VERSION, 1)
  assert.deepEqual(MACHINE_LIFECYCLE_CAPABILITIES, { version: 1, durableJournal: true, readOnlyRecovery: true, threadReadyBeforeDispatch: true })
  const events: MachineLifecycleEvent[] = []
  const receipt = await runMachine(request, { recoveryDirectory: journal, env: { FAKE_MACHINE_CAPTURE: capture },
    onLifecycle: async event => {
      events.push(event)
      if (['thread-ready', 'dispatch-intent', 'dispatch-possible'].includes(event.event)) {
        await delay(30)
        assert.equal(turns(capture), 0, 'turn sent before its checkpoint ACK')
        const pending = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: event.runId, recoveryDirectory: journal })
        assert.equal(pending.status, 'pending')
        assert.deepEqual(pending.lifecycle, event)
      }
      if (event.event === 'terminal' || event.event === 'cleanup-confirmed') {
        const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: event.runId, recoveryDirectory: journal })
        assert.equal(recovered.status, 'terminal', 'receipt must be durable before final notification')
        assert.equal(recovered.receipt?.ok, true)
      }
    } })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.deepEqual(events.map(e => e.event), ['thread-ready', 'dispatch-intent', 'dispatch-possible', 'turn-accepted', 'terminal', 'cleanup-confirmed'])
  assert.deepEqual(events.map(e => e.sequence), [1, 2, 3, 4, 5, 6])
  assert.equal(events[0]?.configuration?.matched, true)
  assert.equal(events[0]?.dispatch, 'not-dispatched')
  assert.equal(events[2]?.dispatch, 'possible')
  assert.equal(events[3]?.turnId, 'machine-turn')
  assert.equal(events[5]?.cleanupConfirmed, true)
  assert.equal(turns(capture), 1)
  const before = statSync(join(journal, 'machine-journal.json')).mtimeMs
  const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: receipt.runId, recoveryDirectory: journal })
  assert.deepEqual(recovered.receipt, receipt)
  assert.equal(statSync(join(journal, 'machine-journal.json')).mtimeMs, before)
  assert.equal(turns(capture), 1, 'read-only recovery must not dispatch another turn')
  assert.equal(readFileSync(join(journal, 'machine-journal.json'), 'utf8').includes(request.prompt), false)
})

for (const stage of ['thread-ready', 'dispatch-intent', 'dispatch-possible'] as const) {
  test('negative ACK at ' + stage + ' prevents turn dispatch and preserves physical cleanup', async t => {
    const { request, capture, journal } = fixture(t)
    const receipt = await runMachine(request, { recoveryDirectory: journal, env: { FAKE_MACHINE_CAPTURE: capture },
      onLifecycle: event => { if (event.event === stage) throw new Error('durable write rejected') } })
    assert.equal(receipt.ok, false)
    assert.equal(turns(capture), 0)
    assert.equal((receipt.outcome ?? receipt.failure)?.cleanup?.confirmed, true)
    const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: receipt.runId, recoveryDirectory: journal })
    assert.equal(recovered.status, 'terminal')
    assert.deepEqual(recovered.receipt, receipt)
    assert.equal(recovered.lifecycle?.dispatch, stage === 'dispatch-possible' ? 'possible' : 'not-dispatched')
  })
}

test('callback delivery failure after terminal does not erase successful native facts', async t => {
  const { request, journal } = fixture(t)
  const receipt = await runMachine(request, { recoveryDirectory: journal,
    onLifecycle: event => { if (event.event === 'terminal') throw new Error('consumer has closed') } })
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.outcome?.execution.cancelled, false)
  const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: receipt.runId, recoveryDirectory: journal })
  assert.deepEqual(recovered.receipt, receipt)
})

test('missing, wrong identity, corrupt and aliased journals are unknown without writes or spawning', async t => {
  const { dir, request, capture, journal } = fixture(t)
  const receipt = await runMachine(request, { recoveryDirectory: journal, env: { FAKE_MACHINE_CAPTURE: capture } })
  const input = { protocol: 1 as const, requestId: request.requestId, runId: receipt.runId, recoveryDirectory: journal }
  assert.equal((await recoverMachine({ ...input, runId: 'another-run' })).status, 'unknown')
  assert.equal((await recoverMachine({ ...input, requestId: 'another-request' })).status, 'unknown')
  assert.equal((await recoverMachine({ ...input, recoveryDirectory: join(dir, 'absent') })).status, 'unknown')
  const alias = join(dir, 'alias')
  symlinkSync(journal, alias)
  assert.equal((await recoverMachine({ ...input, recoveryDirectory: alias })).status, 'unknown')
  writeFileSync(join(journal, 'machine-journal.json'), '{"body": {"receipt": "invented"}, "sha256": "wrong"}\n')
  const unchanged = readFileSync(join(journal, 'machine-journal.json'), 'utf8')
  assert.equal((await recoverMachine(input)).status, 'unknown')
  assert.equal(readFileSync(join(journal, 'machine-journal.json'), 'utf8'), unchanged)
  assert.equal(turns(capture), 1)
  await assert.rejects(recoverMachine({ ...input, unknown: true } as never), /invalid machine recovery/)
})

test('a journal is an exclusive admission token, never a requestId-based automatic retry', async t => {
  const { request, capture, journal } = fixture(t)
  const first = await runMachine(request, { recoveryDirectory: journal, env: { FAKE_MACHINE_CAPTURE: capture } })
  const bytes = readFileSync(join(journal, 'machine-journal.json'))
  await assert.rejects(runMachine(request, { recoveryDirectory: journal, env: { FAKE_MACHINE_CAPTURE: capture } }), /supervisor/)
  assert.equal(turns(capture), 1)
  assert.deepEqual(readFileSync(join(journal, 'machine-journal.json')), bytes)
  assert.equal((await recoverMachine({ protocol: 1, requestId: request.requestId, runId: first.runId, recoveryDirectory: journal })).status, 'terminal')
})

test('persistent thread readiness requires observed persistence, not a missing boolean treated as false', async t => {
  const { request, capture, journal } = fixture(t)
  const events: MachineLifecycleEvent[] = []
  const result = await runMachine(request, { recoveryDirectory: journal,
    env: { FAKE_MACHINE_CAPTURE: capture, FAKE_MACHINE_MODE: 'missing-ephemeral' }, onLifecycle: event => { events.push(event) } })
  assert.equal(result.ok, false)
  assert.equal(result.failure?.execution?.dispatch, 'not-dispatched')
  assert.equal(events.some(event => event.event === 'thread-ready'), false)
  assert.equal(turns(capture), 0)
  assert.equal(result.failure?.cleanup?.confirmed, true)
})

test('killing the machine supervisor leaves pending evidence even when its native guardian later cleans up', { timeout: 15_000 }, async t => {
  const { dir, request, capture, journal } = fixture(t)
  const nativeFile = join(dir, 'native-process.json')
  let hostPid: number | undefined, accepted: MachineLifecycleEvent | undefined, release: () => void = () => {}
  const originalFork = childProcess.fork
  // Observe the real spawned supervisor for fault injection; execution is not mocked.
  childProcess.fork = (...args: Parameters<typeof childProcess.fork>) => {
    const child = originalFork(...args)
    if (String(args[0]).endsWith('machine-supervisor.ts')) hostPid = child.pid
    return child
  }
  syncBuiltinESMExports()
  t.after(() => { childProcess.fork = originalFork; syncBuiltinESMExports(); release() })
  const result = runMachine(request, { recoveryDirectory: journal,
    env: { FAKE_MACHINE_CAPTURE: capture, FAKE_MACHINE_MODE: 'turn-hang', FAKE_MACHINE_PROCESS_FILE: nativeFile },
    onLifecycle: async event => {
      if (event.event === 'turn-accepted') { accepted = event; await new Promise<void>(resolve => { release = resolve }) }
    } })
  result.catch(() => {})
  await until(() => accepted !== undefined && hostPid !== undefined && existsSync(nativeFile), 'active supervised turn')
  const group = (JSON.parse(readFileSync(nativeFile, 'utf8')) as { processGroupId: number }).processGroupId
  process.kill(hostPid!, 'SIGKILL')
  await assert.rejects(result, /supervisor exited/)
  release()
  await until(() => { try { process.kill(-group, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } }, 'guardian cleanup after supervisor death')
  const recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: accepted!.runId, recoveryDirectory: journal })
  assert.equal(recovered.status, 'pending')
  assert.equal(recovered.receipt, null)
  assert.equal(recovered.lifecycle?.dispatch, 'accepted')
  assert.equal(recovered.lifecycle?.cleanupConfirmed, false)
  assert.equal(turns(capture), 1)
})

for (const stage of ['thread-ready', 'turn-accepted', 'terminal', 'cleanup-confirmed'] as const) {
  test('whole caller process-group SIGKILL at ' + stage + ' leaves supervised, read-only recoverable evidence', { timeout: 20_000 }, async t => {
    const { dir, request, capture, journal } = fixture(t)
    const checkpoint = join(dir, 'checkpoint.json')
    const script = `import { runMachine } from ${JSON.stringify(source)};
      import { writeFileSync } from 'node:fs';
      await runMachine(${JSON.stringify(request)}, { recoveryDirectory: ${JSON.stringify(journal)},
        env: {FAKE_MACHINE_CAPTURE: ${JSON.stringify(capture)}, FAKE_MACHINE_MODE: ${JSON.stringify(stage === 'turn-accepted' ? 'turn-hang' : 'success')}},
        onLifecycle: async e => { if (e.event === ${JSON.stringify(stage)}) { writeFileSync(${JSON.stringify(checkpoint)}, JSON.stringify(e)); await new Promise(() => {}); } } });`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const exited = new Promise<void>(resolve => { child.once('close', () => resolve()) })
    child.stderr.on('data', () => {})
    t.after(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already reaped */ } })
    await until(() => existsSync(checkpoint), 'checkpoint ' + stage)
    const event = JSON.parse(readFileSync(checkpoint, 'utf8')) as MachineLifecycleEvent
    process.kill(-child.pid!, 'SIGKILL')
    await exited
    let recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: event.runId, recoveryDirectory: journal })
    const end = Date.now() + 10_000
    while (recovered.status !== 'terminal' && Date.now() < end) {
      await delay(25)
      recovered = await recoverMachine({ protocol: 1, requestId: request.requestId, runId: event.runId, recoveryDirectory: journal })
    }
    assert.equal(recovered.status, 'terminal', JSON.stringify(recovered))
    const native = recovered.receipt?.outcome ?? recovered.receipt?.failure
    assert.equal(native?.cleanup?.confirmed, true)
    assert.equal(recovered.receipt?.ok, stage === 'terminal' || stage === 'cleanup-confirmed')
    if (stage === 'terminal' || stage === 'cleanup-confirmed') assert.equal(native?.execution?.cancelled, false)
    assert.equal(turns(capture), stage === 'thread-ready' ? 0 : 1)
    const pgid = native?.execution?.supervisorPid
    assert.ok(pgid)
    assert.throws(() => process.kill(-pgid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH')
  })
}

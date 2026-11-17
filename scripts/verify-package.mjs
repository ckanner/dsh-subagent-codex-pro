// Exercise exactly the built npm tarball through public exports and its installed bin.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'codex-pro-package-')))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const env = { ...process.env, CODEX_SUBAGENT_LIVE: '0' }
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: temp, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout)
  return result.stdout
}
try {
  // npm 12 changes the machine-readable `pack --json` shape. The tarball on
  // disk is the contract this smoke needs, and its name is stable across npm
  // versions, so discover it directly instead of parsing npm's JSON envelope.
  execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', temp],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
  const tarballs = readdirSync(temp).filter((name) => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `expected one packed tarball, found ${tarballs.join(', ')}`)
  const install = join(temp, 'installed')
  mkdirSync(install)
  run(npm, ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, tarballs[0])])
  assert.equal(existsSync(join(install, 'node_modules/@deepseek-ai/schemastery')), false,
    'the standalone machine consumer must not install the optional desktop schema peer')
  assert.ok(existsSync(join(install, 'node_modules/dsh-subagent-codex-pro/assets/native-client.js')),
    'the desktop client must be shipped in the real tarball')
  const command = join(temp, 'fake-codex.mjs')
  copyFileSync(join(root, 'tests/fixtures/machine-server.mjs'), command)
  chmodSync(command, 0o755)
  const request = { protocol: 1, requestId: 'packed-call', prompt: 'Exercise the real installed entry.',
    cwd: temp, model: 'package-test-model', effort: 'high', permissionMode: 'workspace-write', command, timeoutMs: 5000 }
  const bin = join(install, 'node_modules/.bin/codex-pro-machine')
  const capabilities = JSON.parse(run(bin, ['--capabilities']))
  assert.equal(capabilities.protocol, 1)
  assert.equal(capabilities.inferenceRequests, 0)
  assert.ok(capabilities.permissions.includes('workspace-write'))
  assert.equal(capabilities.javascriptLifecycle.version, 1)
  assert.equal(capabilities.native.version, 1)
  assert.equal(capabilities.javascriptActivity.version, 1)
  const nativeReceipt = JSON.parse(run(bin, ['--json'], { input: JSON.stringify({ ...request, native: { version: 1, agents: { enabled: false } } }) }))
  assert.equal(nativeReceipt.ok, true)
  assert.equal(nativeReceipt.native.effective.matched, true)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(run(bin, ['--version']).trim(), manifest.version)
  const receipt = JSON.parse(run(bin, ['--json'], { input: JSON.stringify(request) }))
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  assert.equal(receipt.requestId, request.requestId)
  assert.equal(receipt.outcome.execution.ownership, 'supervised-group')
  assert.equal(receipt.outcome.cleanup.confirmed, true)
  assert.equal(receipt.outcome.configuration.effective.model, request.model)
  assert.equal(receipt.outcome.usage.run.totalTokens, 140)
  // Resolve the installed public subpath, never a source/deep import.
  writeFileSync(join(install, 'consumer.mjs'),
    'import { runMachine } from "dsh-subagent-codex-pro/machine";\n'
    + 'const receipt = await runMachine(' + JSON.stringify(request) + ');\n'
    + 'if (!receipt.ok) throw new Error(JSON.stringify(receipt));\n'
    + 'process.stdout.write(JSON.stringify({ok:receipt.ok,requestId:receipt.requestId}));\n')
  assert.deepEqual(JSON.parse(run(process.execPath, [join(install, 'consumer.mjs')])), { ok: true, requestId: 'packed-call' })
  writeFileSync(join(install, 'recovery-consumer.mjs'),
    'import { runMachine, recoverMachine, MACHINE_LIFECYCLE_VERSION } from "dsh-subagent-codex-pro/machine";\n'
    + 'const events = []; const directory = ' + JSON.stringify(join(temp, 'recovery-journal')) + ';\n'
    + 'const receipt = await runMachine(' + JSON.stringify(request) + ', { recoveryDirectory: directory, onLifecycle: e => { events.push(e.event); } });\n'
    + 'const recovered = await recoverMachine({ protocol: 1, requestId: receipt.requestId, runId: receipt.runId, recoveryDirectory: directory });\n'
    + 'if (!receipt.ok || JSON.stringify(recovered.receipt) !== JSON.stringify(receipt)) throw new Error("installed lifecycle evidence mismatch");\n'
    + 'process.stdout.write(JSON.stringify({ version: MACHINE_LIFECYCLE_VERSION, status: recovered.status, events }));\n')
  assert.deepEqual(JSON.parse(run(process.execPath, [join(install, 'recovery-consumer.mjs')])), {
    version: 1, status: 'terminal', events: ['thread-ready', 'dispatch-intent', 'dispatch-possible', 'turn-accepted', 'terminal', 'cleanup-confirmed'],
  })
  writeFileSync(join(install, 'activity-consumer.mjs'),
    'import { runMachine, MACHINE_ACTIVITY_CAPABILITIES } from "dsh-subagent-codex-pro/machine";\n'
    + 'const events = []; const receipt = await runMachine(' + JSON.stringify({ ...request, maxOutputBytes: 8192, threadMode: 'persistent', threadName: 'Flywheel · package · Design', native: { version: 1, agents: { enabled: true } } })
    + ', { env: { FAKE_MACHINE_MODE: "activity-child" }, onLifecycle() {}, activityIntervalMs: 30, onActivity: e => events.push(e) });\n'
    + 'if (!receipt.ok || !events.some(e => e.eventTypes.includes("item/reasoning/summaryTextDelta"))) throw new Error("installed activity missing");\n'
    + 'if (JSON.stringify(events).includes("PRIVATE_REASONING")) throw new Error("activity leaked body");\n'
    + 'process.stdout.write(JSON.stringify({ version: MACHINE_ACTIVITY_CAPABILITIES.version, ok: receipt.ok }));\n')
  assert.deepEqual(JSON.parse(run(process.execPath, [join(install, 'activity-consumer.mjs')])), { version: 1, ok: true })
  const nameCommand = join(temp, 'name-admission-server.mjs')
  copyFileSync(join(root, 'tests/fixtures/thread-name-admission-server.mjs'), nameCommand)
  chmodSync(nameCommand, 0o755)
  writeFileSync(join(install, 'name-admission-consumer.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMachine, recoverMachine } from 'dsh-subagent-codex-pro/machine';
const base = ${JSON.stringify({ ...request, command: nameCommand, threadMode: 'persistent' })};
for (const explicit of [true, false]) {
  const request = { ...base, requestId: 'packed-name-' + explicit,
    ...(explicit ? { threadName: 'Flywheel · package · Naming admission' } : {}) };
  const capture = join(base.cwd, 'name-calls-' + explicit + '.jsonl');
  const directory = join(base.cwd, 'name-journal-' + explicit);
  const events = [];
  const receipt = await runMachine(request, { recoveryDirectory: directory,
    env: { CODEX_NAME_ADMISSION_MODE: 'reject', CODEX_NAME_ADMISSION_CAPTURE: capture },
    onLifecycle: event => events.push(event.event) });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.failure?.stage, 'thread-name');
  assert.equal(receipt.failure?.category, 'protocol');
  assert.equal(receipt.failure?.execution?.dispatch, 'not-dispatched');
  assert.equal(receipt.failure?.execution?.threadId, 'name-admission-thread');
  assert.equal(receipt.failure?.cleanup?.confirmed, true);
  assert.deepEqual(events, ['terminal', 'cleanup-confirmed']);
  const calls = readFileSync(capture, 'utf8');
  const methods = calls.trim().split('\\n').map(line => JSON.parse(line).method);
  assert.equal(methods.filter(method => method === 'thread/name/set').length, 1);
  assert.equal(methods.includes('turn/start'), false);
  const recovered = await recoverMachine({ protocol: 1, requestId: receipt.requestId,
    runId: receipt.runId, recoveryDirectory: directory });
  assert.equal(recovered.status, 'terminal');
  assert.deepEqual(recovered.receipt, receipt);
  assert.equal(readFileSync(capture, 'utf8'), calls);
}
process.stdout.write(JSON.stringify({ explicit: true, fallback: true, recovery: true }));
`)
  assert.deepEqual(JSON.parse(run(process.execPath, [join(install, 'name-admission-consumer.mjs')])),
    { explicit: true, fallback: true, recovery: true })
  const snapshotCommand = join(temp, 'native-snapshot-order-server.mjs')
  copyFileSync(join(root, 'tests/fixtures/native-snapshot-order-server.mjs'), snapshotCommand)
  chmodSync(snapshotCommand, 0o755)
  writeFileSync(join(install, 'native-snapshot-consumer.mjs'), `
import assert from 'node:assert/strict';
import { runMachine } from 'dsh-subagent-codex-pro/machine';
const request = ${JSON.stringify({ ...request, command: snapshotCommand, native: { version: 1, agents: { enabled: true } } })};
for (const mode of ['child-first', 'parent-first', 'next-pending', 'next-completed', 'v2-child-first',
  'parent-only', 'v2-parent-only', 'parent-only-queued', 'parent-only-next-completed']) {
  const native = mode.startsWith('v2-')
    ? { version: 1, agents: { enabled: true, backend: 'v2' } } : request.native;
  const receipt = await runMachine({ ...request, native, requestId: 'packed-snapshot-' + mode },
    { env: { NATIVE_SNAPSHOT_ORDER: mode }, onLifecycle() {} });
  const complete = mode !== 'next-pending' && mode !== 'parent-only-queued';
  assert.equal(receipt.ok, complete, JSON.stringify(receipt));
  assert.equal(receipt.native?.completion.confirmed, complete);
  assert.equal(receipt.outcome?.cleanup.confirmed, true);
  assert.equal(receipt.native?.children.length, 1);
  assert.equal(receipt.native.children[0].state, complete ? 'completed' : 'running');
  if (mode.includes('parent-only') && mode !== 'parent-only-next-completed') {
    assert.equal(receipt.native.children[0].turnId, null);
    assert.equal(receipt.native.children[0].usage.status, 'unknown');
    assert.equal(receipt.native.usage.totalTokens, null);
  }
  if (!complete) assert.equal(receipt.outcome?.execution.failure?.category, 'completion');
}
process.stdout.write(JSON.stringify({ creationOrdering: true, newTurnPending: true }));
`)
  assert.deepEqual(JSON.parse(run(process.execPath, [join(install, 'native-snapshot-consumer.mjs')])),
    { creationOrdering: true, newTurnPending: true })
  // Host entry points use the optional schema peer. Install it only after the
  // standalone machine checks above have proved that it is not required there.
  run(npm, ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', '@deepseek-ai/schemastery@3.19.0'])
  writeFileSync(join(install, 'host-history-consumer.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexExecProvider } from 'dsh-subagent-codex-pro';
const base = ${JSON.stringify({ cwd: temp, command, model: request.model })};
for (const threadMode of [undefined, 'ephemeral', 'persistent', 'session']) {
  const persistent = threadMode === 'persistent' || threadMode === 'session';
  const capture = join(base.cwd, 'host-' + (threadMode ?? 'default') + '.jsonl');
  const provider = new CodexExecProvider({ providerName: 'packed-host', command: base.command,
    permissionMode: 'workspace-write', model: base.model, runTimeoutMs: 5000,
    originator: 'Packed Host history', ...(threadMode === undefined ? {} : { threadMode }),
    env: { FAKE_MACHINE_MODE: 'host-persistence', FAKE_MACHINE_CAPTURE: capture } });
  for (const label of ['First history', 'Second history']) {
    const run = await provider.start({ parent: { session: { header: { cwd: base.cwd } } },
      prompt: [{ type: 'text', text: 'fixture' }], signal: new AbortController().signal, label });
    try { assert.equal((await run.result).stopReason, 'completed'); } finally { await run.dispose(); }
  }
  const messages = readFileSync(capture, 'utf8').trim().split('\\n').map(JSON.parse);
  assert.deepEqual(messages.filter(m => m.method === 'thread/start').map(m => m.params.ephemeral), [!persistent, !persistent]);
  assert.equal(messages.some(m => m.method === 'thread/resume'), false);
  assert.equal(new Set(messages.filter(m => m.method === 'turn/start').map(m => m.params.threadId)).size, 2);
  assert.deepEqual(messages.filter(m => m.method === 'thread/name/set').map(m => m.params.name),
    persistent ? ['DSH · First history', 'DSH · Second history'] : []);
  assert.deepEqual(messages.filter(m => m.method === 'initialize').map(m => m.params.clientInfo.name),
    ['Packed Host history', 'Packed Host history']);
}
process.stdout.write(JSON.stringify({ hostHistory: true, freshPerCall: true, ephemeral: true, configuredOriginator: true }));
`)
  assert.deepEqual(JSON.parse(run(process.execPath, [join(install, 'host-history-consumer.mjs')], { env: { ...env, DSH_HOME: temp } })),
    { hostHistory: true, freshPerCall: true, ephemeral: true, configuredOriginator: true })
  process.stdout.write(JSON.stringify({ ok: true, version: manifest.version,
    actualNpmInstall: true, publicMachineAPI: true, installedCLI: true,
    builtGuardian: true, builtMachineSupervisor: true, providerActivity: true, durableLifecycle: true,
    readOnlyRecovery: true, requiredNaming: true, childCreationOrdering: true, hostProviderHistory: true, inferenceRequests: 0 }) + '\n')
} finally {
  rmSync(temp, { recursive: true, force: true })
}

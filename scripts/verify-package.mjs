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
  process.stdout.write(JSON.stringify({ ok: true, version: manifest.version,
    actualNpmInstall: true, publicMachineAPI: true, installedCLI: true,
    builtGuardian: true, builtMachineSupervisor: true, durableLifecycle: true, readOnlyRecovery: true, inferenceRequests: 0 }) + '\n')
} finally {
  rmSync(temp, { recursive: true, force: true })
}

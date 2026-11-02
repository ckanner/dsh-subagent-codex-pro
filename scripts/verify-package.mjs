// Exercise exactly the built npm tarball through public exports and its installed bin.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'codex-pro-package-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const env = { ...process.env, CODEX_SUBAGENT_LIVE: '0' }
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: temp, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout)
  return result.stdout
}
try {
  const raw = execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
  const parsed = JSON.parse(raw)
  const packed = Array.isArray(parsed) ? parsed[0] : parsed
  assert.equal(typeof packed.filename, 'string')
  const install = join(temp, 'installed')
  mkdirSync(install)
  run(npm, ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed.filename)])
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
  process.stdout.write(JSON.stringify({ ok: true, version: manifest.version,
    actualNpmInstall: true, publicMachineAPI: true, installedCLI: true,
    builtGuardian: true, inferenceRequests: 0 }) + '\n')
} finally {
  rmSync(temp, { recursive: true, force: true })
}

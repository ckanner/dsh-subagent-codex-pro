#!/usr/bin/env node
/** One request on stdin, one versioned receipt on stdout. No DSH parent required. */
import { readFileSync } from 'node:fs'
import { MachineInputError, parseMachineRequest, runMachine } from './machine.ts'

const MAX_INPUT_BYTES = 1024 * 1024
// A consumer may close the read end before the receipt is written. EPIPE is a
// consumer choice, not a crash; exit non-zero so the outer owner sees the lost
// receipt without an unhandled stack. Other stdout errors remain fatal.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(1)
  throw error
})
const argv = process.argv.slice(2)
const controller = new AbortController()
let cancelledBy: 'SIGTERM' | 'SIGINT' | undefined
const cancel = (signal: 'SIGTERM' | 'SIGINT'): void => {
  cancelledBy ??= signal
  controller.abort()
}
const term = (): void => cancel('SIGTERM')
const interrupt = (): void => cancel('SIGINT')

async function input(): Promise<unknown> {
  let bytes = 0
  const chunks: Buffer[] = []
  const stopInput = (): void => { process.stdin.destroy(new Error('input cancelled')) }
  controller.signal.addEventListener('abort', stopInput, { once: true })
  try {
    if (controller.signal.aborted) throw new MachineInputError('input cancelled')
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bytes += buffer.length
      if (bytes > MAX_INPUT_BYTES) throw new MachineInputError('stdin exceeds the 1 MiB request limit')
      chunks.push(buffer)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch { throw new MachineInputError('stdin must contain one JSON request') }
  } finally {
    controller.signal.removeEventListener('abort', stopInput)
  }
}

async function main(): Promise<number> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0] ?? '')) {
    process.stdout.write('Usage: codex-pro-machine [--json] < request.json\n'
      + 'Read one protocol=1 request and emit one JSON receipt. SIGINT/SIGTERM cancel and await cleanup.\n'
      + 'Use --capabilities for the offline protocol declaration.\n')
    return 0
  }
  if (argv.length === 1 && argv[0] === '--version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    process.stdout.write(pkg.version + '\n')
    return 0
  }
  if (argv.length === 1 && argv[0] === '--capabilities') {
    process.stdout.write(JSON.stringify({
      protocol: 1, type: 'capabilities', package: 'dsh-subagent-codex-pro',
      platform: process.platform, supported: process.platform !== 'win32',
      permissions: ['read-only', 'workspace-write', 'dangerously-bypass-approvals-and-sandbox'],
      input: 'single-json-document', maxInputBytes: MAX_INPUT_BYTES,
      cancellation: ['SIGINT', 'SIGTERM'], ownership: 'supervised-group',
      effortEvidence: 'accepted-request-only', cost: 'unknown', inferenceRequests: 0,
    }) + '\n')
    return 0
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--json')) {
    throw new MachineInputError('unsupported command argument; use --help')
  }
  const request = parseMachineRequest(await input())
  const receipt = await runMachine(request, { signal: controller.signal })
  process.stdout.write(JSON.stringify(receipt) + '\n')
  return receipt.ok ? 0 : 1
}

process.on('SIGTERM', term)
process.on('SIGINT', interrupt)
try {
  process.exitCode = await main()
} catch (error: unknown) {
  process.stdout.write(JSON.stringify({
    protocol: 1, type: 'error', requestId: null,
    error: { code: error instanceof MachineInputError ? error.code : 'INPUT_ERROR',
      message: error instanceof MachineInputError ? error.message : 'machine request could not be read' },
  }) + '\n')
  process.exitCode = 2
} finally {
  if (cancelledBy !== undefined) process.exitCode = cancelledBy === 'SIGTERM' ? 143 : 130
  process.off('SIGTERM', term)
  process.off('SIGINT', interrupt)
}

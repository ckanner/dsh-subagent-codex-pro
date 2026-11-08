#!/usr/bin/env node
// A real process implementing only the app-server messages needed by contract tests.
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
const mode = process.env.FAKE_MACHINE_MODE ?? 'success'
if (process.env.FAKE_MACHINE_PROCESS_FILE) writeFileSync(process.env.FAKE_MACHINE_PROCESS_FILE,
  JSON.stringify({ pid: process.pid, processGroupId: process.ppid }))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (id, result) => send({ id, result })
const notify = (method, params) => send({ method, params })
const usage = (n) => ({ totalTokens: n, inputTokens: n - 10, outputTokens: 10,
  cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 })
process.on('SIGTERM', () => process.exit(0))
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  const p = message.params ?? {}
  if (process.env.FAKE_MACHINE_CAPTURE) appendFileSync(process.env.FAKE_MACHINE_CAPTURE, JSON.stringify(message) + '\n')
  if (message.method === 'initialize') {
    if (mode !== 'startup-hang') reply(message.id, {})
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const result = {
      thread: { id: p.threadId ?? 'machine-thread', ephemeral: p.ephemeral === true },
      cwd: p.cwd, model: mode === 'wrong-model' ? 'another-model' : p.model ?? 'default-model',
      approvalPolicy: p.approvalPolicy ?? 'never', approvalsReviewer: p.approvalsReviewer ?? 'user',
      sandbox: p.sandbox === 'read-only' ? { type: 'readOnly' }
        : p.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
        : { type: 'workspaceWrite', writableRoots: [p.cwd], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      reasoningEffort: null,
    }
    if (mode === 'missing-model') delete result.model
    if (mode === 'wrong-ephemeral') result.thread.ephemeral = false
    if (mode === 'missing-ephemeral') delete result.thread.ephemeral
    reply(message.id, result)
  } else if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: 'machine-turn' } })
    if (mode === 'declined') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/commandExecution/requestApproval',
        params: { threadId: p.threadId, turnId: 'machine-turn', itemId: 'item-1',
          availableDecisions: ['decline'] } })
    }
    if (mode === 'turn-hang') continue
    setImmediate(() => {
      for (const total of [100, 140, 140]) notify('thread/tokenUsage/updated', {
        threadId: p.threadId, turnId: 'machine-turn',
        tokenUsage: { total: usage(total), last: usage(20), modelContextWindow: 272000 },
      })
      if (mode === 'bad-usage') notify('thread/tokenUsage/updated', {
        threadId: p.threadId, turnId: 'machine-turn', tokenUsage: { total: usage(-1) },
      })
      notify('item/completed', { threadId: p.threadId, turnId: 'machine-turn',
        item: { type: 'agentMessage', phase: 'final_answer',
          text: mode === 'large-final' ? '{"message":"' + 'X'.repeat(300_000) + '"}' : '{"message":"MACHINE_OK"}' } })
      notify('turn/completed', { threadId: p.threadId, turn: { id: 'machine-turn', status: 'completed' } })
    })
  }
}

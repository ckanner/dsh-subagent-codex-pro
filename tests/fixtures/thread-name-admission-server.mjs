#!/usr/bin/env node
// Minimal real app-server peer for name admission and its no-dispatch boundary.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (id, result) => send({ id, result })
const notify = (method, params) => send({ method, params })
process.on('SIGTERM', () => process.exit(0))

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line), p = message.params ?? {}
  if (process.env.CODEX_NAME_ADMISSION_CAPTURE) {
    appendFileSync(process.env.CODEX_NAME_ADMISSION_CAPTURE, JSON.stringify(message) + '\n')
  }
  if (message.method === 'initialize') reply(message.id, {})
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    reply(message.id, {
      thread: { id: p.threadId ?? 'name-admission-thread', ephemeral: p.ephemeral === true },
      cwd: p.cwd, model: p.model, approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer,
      sandbox: { type: 'workspaceWrite', writableRoots: [p.cwd], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true }, reasoningEffort: null,
    })
  } else if (message.method === 'thread/name/set') {
    if (process.env.CODEX_NAME_ADMISSION_MODE === 'hang') continue
    if (process.env.CODEX_NAME_ADMISSION_MODE === 'reject') {
      send({ id: message.id, error: { code: -32603, message: 'PRIVATE_NATIVE_METADATA_WRITE_FAILURE' } })
    } else reply(message.id, {})
  } else if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: 'name-admission-turn' } })
    notify('item/completed', { threadId: p.threadId, turnId: 'name-admission-turn',
      item: { type: 'agentMessage', phase: 'final_answer', text: 'NAMING_ADMISSION_OK' } })
    notify('turn/completed', { threadId: p.threadId, turn: { id: 'name-admission-turn', status: 'completed' } })
  }
}

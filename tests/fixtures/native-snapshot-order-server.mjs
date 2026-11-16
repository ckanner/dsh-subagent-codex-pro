#!/usr/bin/env node
// App-server fixture: parent and child listeners can deliver creation and turn facts in either order.
import { createInterface } from 'node:readline'

const config = {}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '-c') continue
  const entry = process.argv[++i], split = entry.indexOf('=')
  config[entry.slice(0, split)] = JSON.parse(entry.slice(split + 1).replace(/([a-z_]+)\s*=/g, '"$1":'))
}
const mode = process.env.NATIVE_SNAPSHOT_ORDER ?? 'child-first'
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (id, result) => send({ id, result })
const notify = (method, params) => send({ method, params })
const total = n => ({ totalTokens: n, inputTokens: n - 10, cachedInputTokens: 0,
  outputTokens: 10, reasoningOutputTokens: 0 })
process.on('SIGTERM', () => process.exit(0))

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line), p = message.params ?? {}
  if (message.method === 'initialize') reply(message.id, {})
  else if (message.method === 'config/read') reply(message.id, { config })
  else if (message.method === 'thread/start') reply(message.id, {
    thread: { id: 'root', ephemeral: p.ephemeral === true }, cwd: p.cwd, model: p.model,
    approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer,
    sandbox: { type: 'workspaceWrite', writableRoots: [p.cwd], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true }, reasoningEffort: null,
  })
  else if (message.method === 'thread/name/set' || message.method === 'turn/interrupt') reply(message.id, {})
  else if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: 'root-turn' } })
    notify('turn/started', { threadId: 'root', turn: { id: 'root-turn' } })
    const creation = (status, tool = 'spawnAgent') => notify('item/completed', { threadId: 'root', turnId: 'root-turn', item: mode.startsWith('v2-') ? {
      type: 'subAgentActivity', id: 'spawn-child', agentThreadId: 'child', kind: status === 'running' ? 'started' : status, model: 'child-model',
    } : {
      type: 'collabAgentToolCall', id: tool === 'spawnAgent' ? 'spawn-child' : 'followup-child', tool, senderThreadId: 'root',
      receiverThreadIds: ['child'], model: 'child-model', agentsStates: { child: { status } },
    } })
    const start = id => notify('turn/started', { threadId: 'child', turn: { id } })
    const usage = (turnId, n) => notify('thread/tokenUsage/updated', { threadId: 'child', turnId,
      tokenUsage: { total: total(n) } })
    const complete = id => notify('turn/completed', { threadId: 'child', turn: { id, status: 'completed' } })

    if (mode.includes('parent-only')) {
      creation('completed')
      if (mode === 'parent-only-queued' || mode === 'parent-only-next-completed') {
        creation('running', 'sendInput')
        creation('completed')
        if (mode === 'parent-only-next-completed') {
          start('second-turn')
          usage('second-turn', 70)
          complete('second-turn')
        }
      } else creation('running')
    } else {
      if (mode === 'parent-first') creation('running')
      start('first-turn')
      usage('first-turn', 50)
      complete('first-turn')
      if (mode.startsWith('next-')) {
        start('second-turn')
        usage('second-turn', 70)
        creation('completed')
        if (mode === 'next-completed') complete('second-turn')
      } else if (mode.endsWith('child-first')) creation('running')
    }
    // Delayed content from the first turn cannot count as fresh provider activity.
    notify('item/reasoning/summaryTextDelta', { threadId: 'child', turnId: 'first-turn', itemId: 'old-reasoning',
      summaryIndex: 0, delta: 'STALE_CHILD_CONTENT' })
    notify('thread/tokenUsage/updated', { threadId: 'root', turnId: 'root-turn', tokenUsage: { total: total(100) } })
    notify('item/completed', { threadId: 'root', turnId: 'root-turn', item: {
      type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'PARENT_DONE',
    } })
    notify('turn/completed', { threadId: 'root', turn: { id: 'root-turn', status: 'completed' } })
  }
}

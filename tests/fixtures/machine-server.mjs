#!/usr/bin/env node
// A real process implementing only the app-server messages needed by contract tests.
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { appendFileSync, writeFileSync } from 'node:fs'
const config = {}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '-c') continue
  const entry = process.argv[++i], split = entry.indexOf('=')
  config[entry.slice(0, split)] = JSON.parse(entry.slice(split + 1).replace(/([a-z_]+)\s*=/g, '"$1":'))
}
const mode = process.env.FAKE_MACHINE_MODE ?? 'success'
if (process.env.FAKE_MACHINE_PROCESS_FILE) writeFileSync(process.env.FAKE_MACHINE_PROCESS_FILE,
  JSON.stringify({ pid: process.pid, processGroupId: process.ppid }))
if (process.env.FAKE_MACHINE_ARGV_FILE) writeFileSync(process.env.FAKE_MACHINE_ARGV_FILE, JSON.stringify(process.argv.slice(2)))
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
  } else if (message.method === 'config/read') {
    reply(message.id, { config: mode === 'native-mismatch' ? { ...config, 'agents.enabled': !config['agents.enabled'] } : config })
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
    if (mode === 'native-child-early-root') notify('thread/started', { thread: { id: 'child-1', model: 'child-model',
      source: { subAgent: { thread_spawn: { parent_thread_id: result.thread.id } } } } })
    reply(message.id, result)
  } else if (message.method === 'thread/name/set') {
    reply(message.id, {})
  } else if (message.method === 'turn/start' || message.method === 'review/start') {
    reply(message.id, { turn: { id: 'machine-turn' }, reviewThreadId: p.threadId })
    if (mode.startsWith('activity-')) {
      const root = p.threadId, rootTurn = 'machine-turn';
      notify('turn/started', { threadId: root, turn: { id: rootTurn } });
      if (mode === 'activity-quiet') continue;
      const child = mode.startsWith('activity-child');
      if (child) {
        notify('item/completed', { threadId: root, turnId: rootTurn, item: { type: 'collabAgentToolCall', id: 'spawn-activity', tool: 'spawnAgent', senderThreadId: root, receiverThreadIds: ['activity-child'] } });
        notify('turn/started', { threadId: 'activity-child', turn: { id: 'child-turn' } });
      }
      const tid = mode === 'activity-unowned' ? 'other-thread' : child ? 'activity-child' : root;
      const turn = mode === 'activity-stale-root' ? 'old-turn' : child ? 'child-turn' : rootTurn;
      notify('item/started', { threadId: tid, turnId: turn, item: { type: 'reasoning', id: 'reasoning', summary: [], content: [] } });
      if (mode === 'activity-child-stale') notify('turn/completed', { threadId: tid, turn: { id: turn, status: 'completed' } });
      void (async () => {
        const burst = mode === 'activity-burst';
        const count = burst ? 10_000 : 20;
        for (let i = 0; i < count; i++) {
          if (!notify('item/reasoning/summaryTextDelta', { threadId: tid, turnId: turn, itemId: 'reasoning', summaryIndex: 0,
            delta: burst ? 'x'.repeat(4096) : 'PRIVATE_REASONING' })) await once(process.stdout, 'drain');
          if (!burst) await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (child && mode !== 'activity-child-stale') notify('turn/completed', { threadId: tid, turn: { id: turn, status: 'completed' } });
        notify('item/completed', { threadId: root, turnId: rootTurn, item: { type: 'agentMessage', phase: 'final_answer', text: 'ACTIVITY_OK' } });
        notify('turn/completed', { threadId: root, turn: { id: rootTurn, status: 'completed' } });
      })().catch(() => {});
      continue;
    }
    // A disabled native policy must not spawn fixture children on a later live-settings call.
    if (mode.startsWith('native-child') && config['agents.enabled'] !== false) {
      notify('turn/started', { threadId: 'child-1', turn: { id: 'child-turn' } })
      notify('thread/tokenUsage/updated', { threadId: 'child-1', turnId: 'child-turn', tokenUsage: { total: usage(50) } })
      if (mode !== 'native-child-early-root') notify('item/completed', { threadId: p.threadId, turnId: 'machine-turn', item: { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', senderThreadId: p.threadId, receiverThreadIds: ['child-1'], model: 'child-model', agentsStates: { 'child-1': { status: 'running' } } } })
      notify('thread/tokenUsage/updated', { threadId: 'child-1', turnId: 'child-turn', tokenUsage: { total: usage(50) } })
      send({ id: 701, method: 'item/commandExecution/requestApproval', params: { threadId: 'child-1', turnId: 'child-turn', itemId: 'child-command' } })
      if (mode === 'native-child-hang') continue
      if (mode !== 'native-child-pending') notify('turn/completed', { threadId: 'child-1', turn: { id: 'child-turn', status: 'completed' } })
    }
    if (mode === 'declined') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/commandExecution/requestApproval',
        params: { threadId: p.threadId, turnId: 'machine-turn', itemId: 'item-1',
          availableDecisions: ['decline'] } })
    }
    if (mode === 'turn-hang') continue
    setImmediate(() => {
      if (mode === 'retained-images') for (let i = 0; i < 10; i++) notify('item/completed', {
        threadId: p.threadId, turnId: 'machine-turn', item: { type: 'mcpToolCall', id: 'image-' + i,
          result: { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('x'.repeat(900)).toString('base64') }] } },
      })
      for (const total of [100, 140, 140]) notify('thread/tokenUsage/updated', {
        threadId: p.threadId, turnId: 'machine-turn',
        tokenUsage: { total: usage(total), last: usage(20), modelContextWindow: 272000 },
      })
      if (mode === 'bad-usage') notify('thread/tokenUsage/updated', {
        threadId: p.threadId, turnId: 'machine-turn', tokenUsage: { total: usage(-1) },
      })
      notify('item/completed', { threadId: p.threadId, turnId: 'machine-turn',
        item: message.method === 'review/start' ? { type: 'exitedReviewMode', review: 'NATIVE_REVIEW_OK' } : { type: 'agentMessage', phase: 'final_answer',
          text: mode === 'large-final' ? '{"message":"' + 'X'.repeat(300_000) + '"}' : '{"message":"MACHINE_OK"}' } })
      notify('turn/completed', { threadId: p.threadId, turn: { id: 'machine-turn', status: 'completed' } })
    })
  }
}

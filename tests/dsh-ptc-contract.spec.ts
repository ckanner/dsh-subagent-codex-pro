import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { jsonSchemaToTs, renderToolsSdk } from '@deepseek-ai/dsh-tool-executor-ptc'
import { createCodexTool, createCodexReviewTool } from '../src/tool.ts'

test('real DSH validators and PTC SDK preserve typed native and review parameters for every plugin mode', () => {
  for (const modelSelectionEnabled of [false, true]) {
    for (const backgroundEnabled of [false, true]) {
      for (const threadControlEnabled of [false, true]) {
        const options = { cwd: '/fixture', permissionMode: 'workspace-write' as const, modelSelectionEnabled,
          backgroundEnabled, threadControlEnabled, defaultThreadMode: 'ephemeral' as const,
          run: async () => ({ text: 'fixture', threadId: undefined }), startBackground: () => 'job' }
        const tools = [createCodexTool(options), createCodexReviewTool(options)]
        for (const tool of tools) {
          assertObjectJsonSchema(tool.parameters)
          assertSupportedJsonSchema(tool.output.schema)
          const args = jsonSchemaToTs(tool.parameters)
          assert.notEqual(args, 'unknown')
          assert.match(args, /description: string/)
          if (tool.name === 'subagent_codex') {
            assert.match(args, /prompt: string/)
            assert.match(args, /native\?: null \|/)
            assert.match(args, /enabled: boolean/)
            assert.match(args, /maxConcurrentThreads\?: number/)
          } else {
            assert.match(args, /target:/)
            assert.match(args, /baseBranch/)
            assert.doesNotMatch(args, /prompt:|thread_id\?:|native\?:/)
          }
          const value = { content: [{ type: 'text', text: '{"answer":true}' }], native: { version: 1 } }
          assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
        }
        const sdk = renderToolsSdk(tools.map(tool => ({
          name: tool.name, description: tool.description, parameters: tool.parameters, output: tool.output.schema,
        })))
        assert.match(sdk, /subagent_codex:/)
        assert.match(sdk, /subagent_codex_review:/)
        assert.doesNotMatch(sdk, /subagent_codex(?:_review)?: unknown/)
      }
    }
  }
})

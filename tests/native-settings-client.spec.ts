import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import Renderer from 'react-test-renderer'

const { act, create } = Renderer
const h = React.createElement
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

function loadClient(language = 'en') {
  let module: any
  vm.runInNewContext(readFileSync(new URL('../assets/native-client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value: any) { module = value } } }, navigator: { language }, TextEncoder,
  })
  assert.equal(module.id, 'dsh-subagent-codex-pro')
  const client = module.factory((id: string) => { assert.equal(id, 'react'); return React })
  let component: any, disposed = false, dispose: Function
  client.apply({ effect(fn: Function) { dispose = fn() }, slots: {
    inject(slot: string, fn: Function) { assert.equal(slot, 'plugins.row.config'); return fn() },
    register(entry: unknown, value: any) {
      assert.deepEqual(plain(entry), { name: 'plugins.row.config', key: 'dsh-subagent-codex-pro#codex-pro' })
      component = value; return () => { disposed = true }
    },
  } })
  assert.equal(typeof component, 'function')
  return { component, dispose: () => { dispose!(); assert.equal(disposed, true) } }
}

function editor(t: { after(fn: () => void): void }, state: any, accept = true, language = 'en') {
  const client = loadClient(language)
  const mutations: any[] = []
  let form = { state, mutate: async (ops: unknown, revision: number) => { mutations.push(plain({ ops, revision })); return accept } }
  let tree: any
  act(() => { tree = create(h(client.component, { view: 'page', form })) })
  t.after(() => { act(() => tree.unmount()); client.dispose() })
  return {
    tree, mutations,
    update(value: any) { form = { ...form, state: value }; act(() => tree.update(h(client.component, { view: 'page', form }))) },
    changeMode(value: string) { act(() => tree.root.findByType('select').props.onChange({ target: { value } })) },
    changeInput(index: number, value: string | boolean) {
      act(() => tree.root.findAllByType('input')[index].props.onChange({ target: { value, checked: value } }))
    },
    async save() { await act(async () => { await tree.root.findByType('form').props.onSubmit({ preventDefault() {} }) }) },
  }
}
const state = (revision: number, native: any, user = { native }, writable = true) =>
  ({ status: 'ready', revision, value: { native }, user, base: {}, writable })

test('real React settings client writes whole native values and explicit off without residual fields', async t => {
  const enabled = { version: 1, agents: { enabled: true, maxConcurrentThreads: 2, defaultModel: 'child', defaultEffort: 'high', backend: 'v2' } }
  const view = editor(t, state(7, enabled))
  assert.equal(view.tree.root.findByType('select').props.value, 'agents')
  view.changeMode('off')
  assert.equal(view.tree.root.findAllByType('input').length, 0)
  await view.save()
  assert.deepEqual(view.mutations, [{ revision: 7, ops: [{ op: 'set', path: ['native'], value: null }] }])
  view.update(state(8, null))
  view.changeMode('inherit')
  await view.save()
  assert.deepEqual(view.mutations[1], { revision: 8, ops: [{ op: 'unset', path: ['native'] }] })
})

test('real React settings client validates concurrency and constructs explicit enabled controls', async t => {
  const view = editor(t, state(3, null))
  view.changeMode('agents')
  view.changeInput(0, '1.5')
  await view.save()
  assert.deepEqual(view.mutations, [])
  assert.match(JSON.stringify(view.tree.toJSON()), /positive integer/)
  view.changeInput(0, '3')
  view.changeInput(1, ' child-model ')
  view.changeInput(2, ' low ')
  view.changeInput(3, true)
  await view.save()
  assert.deepEqual(view.mutations, [{ revision: 3, ops: [{ op: 'set', path: ['native'], value: {
    version: 1, agents: { enabled: true, maxConcurrentThreads: 3, defaultModel: 'child-model', defaultEffort: 'low', backend: 'v2' },
  } }] }])
})

test('real React settings client keeps dirty drafts and captured revision across remote conflicts', async t => {
  const view = editor(t, state(1, null), false)
  view.changeMode('agents')
  view.changeInput(1, 'draft-child')
  view.update(state(2, null))
  assert.equal(view.tree.root.findByType('select').props.value, 'agents')
  await view.save()
  assert.equal(view.mutations[0].revision, 1)
  assert.equal(view.tree.root.findAllByType('input')[1].props.value, 'draft-child')
  assert.match(JSON.stringify(view.tree.toJSON()), /draft is retained/)
  const reload = view.tree.root.findAllByType('button').find((button: any) => button.props.type === 'button')
  act(() => reload.props.onClick())
  assert.equal(view.tree.root.findByType('select').props.value, 'off')
})

test('client shows inherited effective values, Chinese labels and read-only status without a write', async t => {
  const view = editor(t, state(9, { version: 1, agents: { enabled: true } }, {}, false), true, 'zh-CN')
  assert.equal(view.tree.root.findByType('select').props.value, 'inherit')
  assert.equal(view.tree.root.findByType('fieldset').props.disabled, true)
  assert.match(JSON.stringify(view.tree.toJSON()), /Codex 原生协作/)
  assert.match(view.tree.root.findByType('pre').children.join(''), /enabled/)
  view.changeMode('off')
  await view.save()
  assert.deepEqual(view.mutations, [])
})

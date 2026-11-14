/* DSH browser closure format. React is supplied by the Host module table. */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-codex-pro',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const zh = typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language)
    const copy = zh ? {
      title: 'Codex 原生协作', mode: '默认能力', inherit: '继承配置', off: '全部关闭', agents: '启用原生 Agent',
      limit: '最多并行子线程（留空使用 CLI 默认）', model: '子 Agent 默认模型（可选）', effort: '子 Agent 默认思考等级（可选）',
      backend: '使用 v2 Agent 后端', save: '保存', reload: '重新载入', saving: '保存中…', saved: '已保存；下一次调用使用新设置。',
      conflict: '未保存：配置可能已更新或不可写。草稿已保留；重新载入后再编辑。', unavailable: '当前配置不可用或不可写。',
      invalidLimit: '并行数必须是大于零且小于 Number.MAX_SAFE_INTEGER 的整数。', effective: '当前生效的 native 配置',
      note: '每次调用可整体覆盖默认值。关闭或继承不会保存下面的 Agent 参数；独立 review 使用 subagent_codex_review 工具。模型选择关闭时，调用者不得改变配置中的子模型与思考等级。',
      summary: '原生 Agent 默认配置与并行能力。',
    } : {
      title: 'Codex native collaboration', mode: 'Default capabilities', inherit: 'Inherit configuration', off: 'All off', agents: 'Enable native Agents',
      limit: 'Maximum concurrent child threads (blank: CLI default)', model: 'Default child model (optional)', effort: 'Default child effort (optional)',
      backend: 'Use the v2 Agent backend', save: 'Save', reload: 'Reload', saving: 'Saving…', saved: 'Saved. New settings apply to the next invocation.',
      conflict: 'Not saved: configuration changed or is not writable. Your draft is retained; reload before editing again.', unavailable: 'Configuration is unavailable or read-only.',
      invalidLimit: 'Concurrency must be a positive integer below Number.MAX_SAFE_INTEGER.', effective: 'Currently effective native configuration',
      note: 'An invocation can replace these defaults as a whole. Off and inherit do not save Agent fields. Independent review uses subagent_codex_review. With model selection disabled, callers cannot change the configured child model or effort.',
      summary: 'Native Agent defaults and concurrency.',
    }
    const own = (value, key) => value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
    const draftOf = state => {
      const native = state?.value?.native
      const agents = native && typeof native === 'object' ? native.agents : undefined
      return {
        mode: !own(state?.user, 'native') ? 'inherit' : native === null || agents?.enabled !== true ? 'off' : 'agents',
        limit: agents?.maxConcurrentThreads === undefined ? '' : String(agents.maxConcurrentThreads),
        model: agents?.defaultModel ?? '', effort: agents?.defaultEffort ?? '', backend: agents?.backend === 'v2',
      }
    }
    const mutationOf = draft => {
      if (draft.mode === 'inherit') return [{ op: 'unset', path: ['native'] }]
      if (draft.mode === 'off') return [{ op: 'set', path: ['native'], value: null }]
      const agents = { enabled: true }
      if (draft.limit.trim() !== '') {
        const n = Number(draft.limit)
        if (!Number.isSafeInteger(n) || n < 1 || n >= Number.MAX_SAFE_INTEGER) throw new Error(copy.invalidLimit)
        agents.maxConcurrentThreads = n
      }
      if (draft.model.trim() !== '') agents.defaultModel = draft.model.trim()
      if (draft.effort.trim() !== '') agents.defaultEffort = draft.effort.trim()
      if (draft.backend) agents.backend = 'v2'
      return [{ op: 'set', path: ['native'], value: { version: 1, agents } }]
    }
    function Editor({ form }) {
      const state = form?.state
      const [draft, setDraft] = React.useState(() => draftOf(state))
      const [revision, setRevision] = React.useState(state?.revision)
      const [dirty, setDirty] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const mounted = React.useRef(true)
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
      React.useEffect(() => {
        if (!dirty && !busy) { setDraft(draftOf(state)); setRevision(state?.revision) }
      }, [state?.revision, state?.status, dirty, busy])
      const ready = state?.status === 'ready' && state.writable && Number.isSafeInteger(state.revision)
      const change = (field, value) => {
        if (!ready || busy) return
        if (!dirty) setRevision(state.revision)
        setDraft(previous => ({ ...previous, [field]: value }))
        setDirty(true); setNotice('')
      }
      const reload = () => {
        setDraft(draftOf(state)); setRevision(state?.revision); setDirty(false); setNotice('')
      }
      const save = async event => {
        event.preventDefault()
        if (!ready || busy || !dirty) return
        let ops
        try { ops = mutationOf(draft) } catch (error) { setNotice(error.message); return }
        setBusy(true); setNotice('')
        try {
          const accepted = await form.mutate(ops, revision)
          if (!mounted.current) return
          if (accepted) { setDirty(false); setNotice(copy.saved) }
          else setNotice(copy.conflict)
        } catch (error) {
          if (mounted.current) setNotice(String(error?.message ?? error))
        } finally { if (mounted.current) setBusy(false) }
      }
      const textField = (key, title, type = 'text') => h('label', { style: { display: 'grid', gap: 4 } }, title,
        h('input', { type, value: draft[key], onChange: event => change(key, event.target.value), ...(type === 'number' ? { min: 1, step: 1 } : {}) }))
      return h('form', { onSubmit: save, style: { display: 'grid', gap: 12 } },
        h('h3', null, copy.title), h('p', null, copy.note),
        h('fieldset', { disabled: !ready || busy, style: { display: 'grid', gap: 12, border: 0, padding: 0, margin: 0 } },
          h('label', null, copy.mode, h('select', { value: draft.mode, onChange: event => change('mode', event.target.value) },
            ...['inherit', 'off', 'agents'].map(value => h('option', { key: value, value }, copy[value])))),
          draft.mode === 'agents' ? h('div', { style: { display: 'grid', gap: 10 } },
            textField('limit', copy.limit, 'number'), textField('model', copy.model), textField('effort', copy.effort),
            h('label', null, h('input', { type: 'checkbox', checked: draft.backend, onChange: event => change('backend', event.target.checked) }), ' ', copy.backend)) : null,
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'submit', disabled: !dirty }, busy ? copy.saving : copy.save),
            h('button', { type: 'button', onClick: reload, disabled: !dirty }, copy.reload))),
        !ready ? h('p', { role: 'status' }, copy.unavailable) : null,
        notice ? h('p', { role: 'status', 'aria-live': 'polite' }, notice) : null,
        h('details', null, h('summary', null, copy.effective),
          h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, state?.value?.native === undefined ? '(CLI / inherited defaults)' : JSON.stringify(state.value.native, null, 2))))
    }
    function NativeSettings(props) {
      return props.view === 'summary' ? h('span', null, copy.summary) : h(Editor, { form: props.form })
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: 'dsh-subagent-codex-pro#codex-pro',
        }, NativeSettings)), 'codex-pro native settings')
      },
    }
  },
})

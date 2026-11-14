# Codex 原生能力与桌面插件（0.10.0 源码候选）

[English](native-capabilities.md) | 中文

本包继续启动用户已经安装、登录的 Codex app-server。它不创建另一套账号、
计费入口或 DSH 子 Agent 运行时。外层 DSH 可以通过 PTC 生成的工具 SDK
调用插件；内层的 Agent、工具、审批、上下文与 Review 仍由 Codex 原生
harness 执行。PTC 与原生能力属于不同层，可以同时使用；本次没有另建
PTC executor，也不声称未经测量的性能提升。

## 在插件里设置默认能力

在 DSH「插件」页面打开本 bundle，再配置 `codex-pro` 行。页面提供：

- 继承配置：删除用户层的 `native` 覆盖；如果基础配置也没有设置，则保留
  Codex CLI 自己的默认行为。
- 全部关闭：保存 `native:null`，明确关闭两个 Agent 后端。
- 启用原生 Agent：设置并发子线程上限、子 Agent 默认模型、默认思考等级，
  以及是否明确选择 V2 后端。

插件导出真正的 Schemastery `Config`，`native` 为 volatile 字段。每次调用
开始读取一次 `.get()` 快照；保存后无需重载插件，已经开始的任务不被中途
改写。其他已有插件参数仍沿用原来的重载语义。页面底部展示实际生效值，
区分“用户层未覆盖”和“显式关闭”。

浏览器入口注册官方 `plugins.row.config`，使用 DSH 共享的 React，不打包
另一套 React。保存通过 owner form 的
`mutate([{op:"set",path:["native"],value}], capturedRevision)` 原子写入整个
native 值；继承用 `unset`。它不深合并旧配置，所以关闭不会保存并发、子模型
或 backend 残留。不可写/未就绪时禁止保存；遇到版本冲突保留草稿及编辑起点
revision，只有明确点“重新载入”才丢弃编辑。

也可以在配置中设置：

```yaml
native:
  version: 1
  agents:
    enabled: true
    maxConcurrentThreads: 3
    defaultModel: your-worker-model
    defaultEffort: high
    backend: v2
```

## 单次委派与默认值覆盖

```js
const result = await tools.subagent_codex({
  description: "实现独立模块",
  prompt: "完成需求；将能够独立验证的工作交给原生子 Agent。",
  native: {
    version: 1,
    agents: { enabled: true, maxConcurrentThreads: 3, backend: "v2" },
  },
})
```

DSH 普通工具执行与 PTC 使用同一个注册工具及运行实现。

| 单次参数 | 行为 |
| --- | --- |
| 不传 `native` | 使用调用开始时的插件默认；插件未设则继承 CLI 默认。 |
| `native:null` | 显式关闭，不是回到默认。 |
| version 1 对象 | 整体替换默认，不逐字段合并。 |
| `agents:{enabled:false}` | 显式关闭，拒绝同时携带其他 Agent 字段。 |
| 对象存在但省略 `agents` | 也会显式关闭 Agent。 |

桌面的 `null` 是插件便利写法，进入共享协议前规范化为
`{version:1,agents:{enabled:false}}`。公开 machine API 的协议仍要求版本化
对象，不接受这个桌面简写。

未知 native 字段、未知工具参数、非法并发以及 disabled 的残留参数，在启动
进程前报错。即使调用者绕过 DSH 的 JSON Schema 校验，也不会被静默忽略。
`modelSelection:false` 允许用户在设置页配置的子模型/effort 默认值正常使用；
单次启用对象必须保持相同选择，包括字段是否省略。新增、改写或通过整体替换
清空这些选择都需要用户修改插件配置；显式关闭仍允许。

`maxConcurrentThreads` 限制同时打开的子线程数量，不是累计 spawn 次数、token
或费用预算。V2 内部计数包含根线程，所以明确选择 V2 时写入 `N+1`。
不写 backend 保留原生后端选择；继承的 V2 配置若与请求上限冲突，配置验证会失败。
不声称关闭某个 V2 特性就能强制任意模型走 V1。

普通原生子 Agent 继续使用 Codex 配置的工具、MCP、角色和模型行为；本插件不把
它们替换成受限帮助工具。子模型与 effort 字段是默认值，不是 Codex 原生模型
allowlist。根线程的 sandbox/审批边界仍由插件配置决定，调用方只能收窄权限；
`native` 不授予额外的文件、进程或网络权限。

## Host provider 与会话复用

最新 DSH `SubagentStartRequest` 的 `agentOptions` 是 Host 的 provider、
model、reasoningEffort、maxTokens 语义，没有通用的 providerOptions/native
字段。Codex provider 读取插件相同的动态 native 默认值，并支持它能够兑现的
model/effort；不支持的有值参数明确拒绝。合法但显式为 undefined 的可选字段不
阻止启动。需要单次 native 覆盖时，使用专用 `subagent_codex` 工具或 machine API。

`threadMode:session` 的隐式复用绑定 native 策略、根模型、effort、权限与 cwd。
其中任一值改变，下一次隐式调用新建线程，避免已有会话掩盖设置变化。显式
`thread_id` 继续支持，包括外部创建的线程；每次都重新应用并验证请求配置。
显式恢复失败会报告错误，不会悄悄换成新线程。可能已经派发的任务不会自动重跑。

## 独立原生 Review

```js
await tools.subagent_codex_review({
  description: "检查分支变更",
  target: { type: "baseBranch", branch: "main" },
  model: "your-review-model",
  reasoning_effort: "high",
})
```

这是单独的、每次明确请求的操作。工具只接受 description、target、cwd、
timeout，以及被允许的 model/effort、后台执行选项。它固定：

- 新的临时线程，不继续实现者的历史。
- read-only sandbox、approvals=never、agents off。
- 在验证新线程后调用 `review/start`，inline 结果必须对应同一线程。

target 支持 `uncommittedChanges`、携带 branch 的 `baseBranch`、携带 sha 和
可选 title 的 `commit`、携带 instructions 的 `custom`。工具不接收普通 prompt、
native、thread_id/thread_mode、图片或 output_schema，因此没有被静默丢弃的
任务语义。插件默认值与普通工具里的 `native.review` 都会被拒绝。

Codex 原生 Review 自身禁用 collaboration、图片查看与 web search。需要原生
多 Agent 参与审查、图片或结构化 verdict 时，使用独立的普通委派并明确 prompt
与 schema。Review 输出是审查证据，不自动等同于 Host 审批或通过验证的
结构化决策。底层 machine Review 的兼容 prompt 字段不会作为普通 turn 提交，
实际审查语义来自 target；桌面专用工具则完全不暴露这个兼容字段。

## 回执、用量与终态

| 入口 | 答案与证据 |
| --- | --- |
| 前台 / PTC 工具 | `{content,native}`：完整原生回执单独保存；答案正文保持不变，render 保留图片附件并另附有界元数据块。 |
| 后台 job | 有原生证据时，result 为 JSON 字符串 `{text,threadId,native}`；没有原生控制时保留原来的纯文本。失败 job 也保留已获得的 native 回执。 |
| Host provider | 保持官方 output/structured 形状；diagnostic 与插件日志记录有界摘要，不虚构 Host 扩展字段。 |
| machine API | 完整原生回执、事件回调及原有私有恢复 journal。 |

Host 摘要包含配置是否匹配、completion/cleanup、pending 数量与截短标记、
子线程状态计数、用量范围/状态和事件截断。它不冒充完整事件账本；需要全部
子线程身份与事件时使用专用工具或 machine API。结构化答案不会被 thread marker、
native JSON 或调试前后缀污染。

原生回执记录 requested、effective、observed、children、usage、completion、
cleanup。只有可信原生父子关系、协作 item 与子 Agent 活动才能建立 ownership；
无关线程的消息不能冒充根答案或子线程用量。父线程 id 尚未到达时，早到的子线程
来源会暂存，根身份确认后再关联。

`native.usage` 统计观察到的子线程，根线程用量仍在 `outcome.usage`。累计快照
不是增量；重复快照不重复计费，恢复线程保留历史基线。未知基线、异常计数、
缺失观察或截断账本会使统计成为 partial/unknown。没有观察到子线程不是零费用
证明。尚未完成的子线程即使已有 token 快照，也不能被宣称为完整终态用量。

根线程发出 final answer 仍不够：原生配置未确认、已观察子线程仍未终结、或
实际进程清理未确认，都会导致失败。原生 child failed 是“已终结”事实，不自动
等同于父任务业务失败；父任务可能已经处理了这个失败。

取消向已知运行中的子 turn 和根 turn 发送 interrupt，然后通过 guardian 有界清理
整个本地进程组。收到 interrupt 回复不等于已经清理；cleanup 以物理进程证据为准。
完整 machine 终态随现有 journal 保存，读取恢复记录不会自动启动新模型。

## 验证范围

本轮本地执行环境不可用，实际验证在 GitHub Actions 的 Node 22/24、
Ubuntu/macOS 矩阵完成。测试使用真正 npm 发布的 Schemastery，真实注册的
插件工具/Host provider 到独立 app-server fixture 子进程的整条路径，以及真实
React 组件的保存、关闭、继承、校验、只读与 revision 冲突交互。打包测试安装
真实 tarball，在没有 DSH peer 的干净消费者中验证公开 machine API、CLI 与
supervisor，并检查浏览器入口确实包含在包中。

这些是离线协议、组件和包验证，不是用户已安装 DSH 桌面端或真实付费模型验收。
版本保持未发布的 0.10.0 candidate。更早的 native machine 测试与 CLI 零模型探测
历史记录见[英文契约的验证部分](native-capabilities.md#verification-and-primary-references)，
不将旧测试算作本轮新执行。

DSH 配置/页面契约以
[39163dd](https://github.com/deepseek-ai/deepseek-harness/tree/39163dd30f703a79079e2d2446545cff3c453738)
的 settings、subagent/types 与 ui-plugin-manager slot-contract 为依据；
Codex 原生协议依据与具体文件链接列于[英文契约](native-capabilities.md#verification-and-primary-references)。

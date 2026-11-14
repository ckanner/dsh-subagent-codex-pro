# dsh-subagent-codex-pro


**0.9.0：**公开 machine API 新增可等待的结构化检查点、私有调用
journal 与只读恢复。独立 supervisor 在调用者死亡后继续清理并保存原始终态回执。
详见[生命周期与恢复](machine-lifecycle.zh.md)；没有因此发布 npm 或改动已有安装。

[English](../README.md) | 中文

一个 Codex 委派工具，**每次调用都可以带上模型和推理强度** —— 这正是 `@deepseek-ai/dsh-subagent-codex` 表达不了的两件事。

```
tools.subagent_codex({
  description: "Probe output PROBE_OK",
  prompt: "Output exactly one line of text: PROBE_OK",
  model: "gpt-6-astra",
  reasoning_effort: "xhigh",
})
```

## 0.10.0 原生机器能力

公开 machine API 新增 Codex 原生多 Agent、逐子线程事件与用量、独立新线程原生 Review，以及显式关闭控制。子 Agent 继续使用原生工具和已配置权限，取消后核对实际进程清理；恢复只读已有回执，不自动重跑。详见[完整能力契约](native-capabilities.md)。本次为源码候选，未发布 npm，也不代表用户 Mac 或真实模型已验收。

## 0.8.0 正式机器入口与迁移

新增 [machine API/CLI](machine.md)，让 Go 等编排器直接复用本包的 Codex 运行核心，
取得版本化收据；无需构造 DSH 父 Agent，也无需解析日志。完整接入边界、需求准备
模型建议、worktree 与 PR 时机见 [编排指南](orchestration.zh.md)。

默认权限改为 workspace-write；旧配置显式full access时保留该选择。DSH能力声明
对齐rc.5：agentOptions、agentPreset=false、outputSchema、depthLimit=false。
无法兑现的provider/maxTokens覆盖明确拒绝；cleanup无法确认时结果失败且dispose拒绝。

## 它补的是什么缺口

`subagent_codex` 的 schema 只暴露 `description` 和 `prompt`，所以调用方**无法指定模型或思考等级**。在一次真实会话里，被要求做这件事的模型试了最直接的做法，结果被拒绝：

```
ToolCallError: child model selection is disabled for this tool instance
```

这条链，从 harness 源码看：

```
工具 schema 暴露 model / reasoning_effort
  ← 仅当 modelSelectionEnabled
modelSelectionEnabled ← 工具行上的 modelSelectionSettings: true
modelSelectionSettings: true ← 要求 provider 声明 `agentOptions`
@deepseek-ai/dsh-subagent-codex ← 声明了 NO_START_CAPABILITIES（没有 agentOptions）
                                → 启用它会在 preset 挂载时抛错
```

Codex 协议支持本包暴露的这些选择：`thread/start` 上的 `model` 和无人值守权限策略，`thread/resume`（0.165+）上的 model/cwd/permission 覆盖，以及每轮 `turn/start` 上的 `effort`。官方 provider 从不发送它们。已上报上游：<https://github.com/deepseek-ai/deepseek-harness/discussions/9115>

还有**第二个独立的缺陷**：在一个 provider 是外部的行（`codex-pro`）上启用 `modelSelectionSettings: true`，会让那一行**静默地**一个工具都不注册 —— 没有报错、没有日志、没有 preset 失败标记。一个除了这个开关之外完全相同的对照行却能正常注册。也写在那份报告里。

## 它改用什么办法

两层，都在本包自己的控制之内。

### 执行：和官方 provider 说同一套协议

`src/wire.ts` 与 `src/run.ts` 是官方 app-server 适配器的移植 —— initialize 握手、临时 thread、thread/turn 关联（包括在 `turn/start` 返回之前就到达的通知）、无人值守的批准决定、以及按 phase 选取终态答复 —— 只加了**两处**：

```js
// thread/start
{ cwd, ephemeral: true, ...(model ? { model } : {}), ...THREAD_PERMISSION_PARAMS[mode] }
// thread/resume（0.165+）
{ threadId, cwd, ...(model ? { model } : {}), ...THREAD_PERMISSION_PARAMS[mode] }
// turn/start
{ threadId, input: [...], effort, ...(outputSchema ? { outputSchema } : {}) }
```

思考等级在 0.165/0.166 里是 `turn/start` 字段，不是 `thread/start` 字段；线程级默认值交给 Codex。

这两个字面量在官方适配器那 871 行里**一次都没出现过**。与源码有两处机械性差异：JSON-RPC 传输是本包自己的（`src/jsonrpc.ts`），以及 app-server 是作为 `<command> app-server --stdio` 从 `PATH` 启动的，而不是从 `@openai/codex` 的 manifest 启动。`src/codex-exec.ts`（更早的 `codex exec` 路径）保留且有测试，但**未使用**。

### 工具注册：用它自己的 context

插件**自己**注册委派工具，在 `agent/created` 时注册进该 Agent 自己的 context —— 也就是 `dsh-plugin-lcu` 给它工具用的那条路：

```ts
ctx.on('agent/created', ({ agent }) => { if (!presetAllows(agent)) return; serve(agent) })
ctx.on('agent-preset/selected', (sessionId, preset) => { … })
// serve(): agent.ctx.tools.register(createCodexTool({ … }))
```

这样就把 harness 的 preset 行机制**完全排除在路径之外**。preset 不需要任何自己的行：`presets` 只声明哪些已确定的 Agent preset 会拿到这个工具 —— 这里是 `daily` 和 `heavy`。

因为工具名是固定的，官方 `subagent_codex` 不能在这些 preset 里同时生效。从 DSH 0.2.1 起，官方 `@deepseek-ai/dsh-subagent-codex` bundle 把 `tool-subagent-codex` 作为**全局 Host 工具**插入（每个 preset 都可见），所以 profile 无法通过禁用一个 per-preset 行来关掉它。本插件在 `agent/created` 时把工具注册进 Agent 自己的 scope，而 scope 内的注册会对该 Agent **遮蔽**全局同名工具 —— 官方 README 记录的是同一条优先级。**同一个** scope 内的两次注册仍然会冲突：后一次抛错，它的工具会**静默地永不出现**，所以 profile 不能在这个 provider 之外再启用一个同名的 `tool-subagent` 行。

**调用里写什么，就跑什么。** `model` 和 `reasoning_effort` 在 schema 里，且调用中的显式选择优先；当一次委派两个都没写时，选择权留给 Codex 自己的配置（`~/.codex/config.toml`）—— 插件**故意不设默认值**，这样不会有任何东西静默覆盖任何一方。`modelSelection: false` 会把这两个字段完全隐藏。

Host 的 `subagent-model-selection` 设置**刻意不被读取**。它授权的是一个从 DSH 目录里选出的子 **LLM 路由**、按 token 计费；而一次 Codex 委派指定的是一个 **Codex 模型 id**，受 Codex CLI 自己的订阅管辖：不同的资源、不同的命名空间。那个设置既不能授权也不能约束这个选择，读它只会把这个工具耦合到一个对它没有任何发言权的设置上。

## 安装

```sh
# 作为 bundle 装进 DSH profile
dsh plugin --profile desktop add dsh-subagent-codex-pro
# 或者从本地检出装，用于开发
dsh plugin --profile desktop add link:/path/to/dsh-subagent-codex-pro
```

## 验证

```sh
npm ci --ignore-scripts
npm run typecheck
npm test                                  # 离线套件；live 用例跳过
CODEX_SUBAGENT_LIVE=1 npm test            # 额外用真实 Codex 跑一次 turn
npm run build
npm run test:package                      # 安装并运行真实打包产物
npm run test:coverage                     # Node 内置覆盖率报告
```

插件把每个决定都记到 `~/.dsh/codex-pro.log`：

```
apply: provider "codex-pro" registered with agentOptions: true; presets=["daily","heavy"]
decide … composed=standard header=standard -> skip
serve …: subagent_codex registered (modelSelection=true, background=true, via=app-server)
run: model=gpt-6-astra effort=xhigh cwd=… prompt=179B via=app-server
run: published 3f2a…
run done: text=8B
```

一次已验证的端到端运行：30 秒墙钟时间，模型的 `PROBE_OK` 作为工具结果返回。真实 app-server 的 live 测试开一个 thread，并把 `effort` 放在 turn 上；它不声称存在线程级 thinking level（0.165/0.166 不接受）。

## 让答案可被机器读取

`output_schema` 把一份 JSON Schema 交给 Codex，它的最终答复**必须**符合该 schema —— 于是后续步骤可以**直接读取**答案，而不必解析正文然后祈祷：

```js
tools.subagent_codex({
  description: "冒烟判定",
  prompt: "判断两个端点是否都返回了 200。",
  output_schema: {
    type: "object",
    properties: { verdict: { type: "string", enum: ["pass", "fail"] }, count: { type: "number" } },
    required: ["verdict", "count"],
    additionalProperties: false,
  },
})
```

schema 必须**以 object 为根** —— 这与 harness 对"它递给 provider 的 schema"所施加的规则一致 —— 因为 Codex 约束的是**整个答复**，而一个裸标量没有地方安放这个形状。app-server 会**强制执行**：实测一次运行返回 `{"verdict":"pass","reason":"…","count":2}`，**没有多余键、必填项齐全**。答复仍以**文本**形式到达，而那段文本就是 JSON。

它放在 **turn** 上、不是 thread 上：同样的字段放在 `thread/start` 上会被**接受然后静默忽略** —— 答复变回散文（两种都实测过）。

由 harness 驱动的 provider（`thread-subagent` 那条路）也能通过它的行配置拿到 schema；本插件现在**声明了这项能力**，并把答复解析出来，使调用方除了文本还能拿到 `structured`。

## 让 Codex 看图

`images` 把图片和任务一起交给 Codex —— 它**收到的是图**，而不是被告知"自己去打开某个文件"：

```js
tools.subagent_codex({
  description: "照着这张设计稿做",
  prompt: "把这个界面的布局在下面的组件里重建出来。",
  images: ["/tmp/design.png"],
})
```

每个路径必须是**绝对路径**、必须**存在**、且必须是**文件**；否则在启动任何东西之前就失败。这道检查不是装饰：**app-server 会静默忽略不存在的 `localImage` 路径** —— 实测如此，turn 照常完成、没有任何报错项 —— 所以不检查的话，一个打错的路径会产出一个**悄悄少了那张图**的委派。

图片以 app-server 的 **`localImage`** 变体发送，这是它**唯一不需要字节传输**就接受的形态：它的 `image` 变体要一个本插件无法构造的 `ImageReference`，而 `{type:'image', data, mimeType}` 和 `data:` URL **都被直接拒绝**。本机路径则无需编码。

给出图片**不会打扰线程**：图片属于这一轮 turn、不属于线程，所以被续接的线程照样可以再看一张新图。

## 指定运行目录

委派默认在**会话的工作目录**里跑。`cwd` 可以指定另一个：

```js
tools.subagent_codex({
  description: "发布后 UI 冒烟",
  prompt: "…",
  cwd: "/tmp/mesh-smoke/20261010-0800",
})
```

路径必须是**绝对路径**、必须**存在**、且必须是**目录**；不满足就明确拒绝并指出问题，而不是"悄悄跑到别处去"。它是**工作目录、不是沙箱边界** —— 一次运行能碰什么由权限模式决定。

**`cwd` 决定的是"新线程"建在哪个目录，它从不迁移旧线程。** 显式的 `thread_id` **优先**：被点名的线程在**它创建的地方**被续接，而同时传的 `cwd` 只改变**被启动进程**的目录，**不改变线程的目录**。实测（真实 app-server）：在 `A` 建的线程，用 `cwd: B` 去续接 —— 运行仍然回答 `CWD=/tmp/dsh-dirA-…`，而且**仍然记得**当初在 `A` 里被告知的内容。所以"停下、问我、再接着干"用的句柄是 **`thread_id`**，传不传 `cwd` 都成立。

插件自己的 `threadMode: session` 复用是**另一回事**，它确实与 `cwd` **不叠加**：那个复用是**插件的选择**而不是调用方的，而它只能在**线程所属的那个目录**里复用。日志会写明每次运行实际用的目录和图片。

传一个与"被续接线程"不一致的 `cwd` **不会报错，也不会移动那份工作** —— 这一点值得知道，因为它看起来像是应该会移。

## 图片

Codex 能看图、也能截图；这个工具现在能把那些图交回来。

**收到什么。** app-server 用两种方式报告图片，两种都被捕获。`imageView` 给的是**本机文件路径** —— 字节从不内联，因为"要求干活的宿主自己去读那个文件"正是它的设计，而这个插件就是那个宿主。computer-use 的截图则以 **MCP 工具结果里的图片内容块**形式到达，里面带着字节。

**投递什么。** 插件读取文件（或解码内容块），把字节交给 harness 的附件存储，并在文字之外返回图片块。模型于是**看到一张图**，而不是关于这张图的描述。

**由模型路由决定 —— 而且这条规则刻意宽松。** 只有当路由**显式声明了**输入模态、而其中**不含** `image` 时，图片才会被拒 —— 这是 harness 自己的规则，因此**未声明**的路由交给 harness 判断，而不是在这里替它做主。默认的 `deepseek-flash` 声明的是 `['text', 'image']`，所以普通会话里截图**是会送达的**。

早先那版守卫在路由解析不出来时**按"拒绝"处理**，结果在本来能显示图片的会话里，把每一张图都静默变成了文字提示 —— 现在不会了：解析不出来的路由**照常投递**。当路由**确实**拒绝图片时，提示是 `[image not delivered: this model route declares no image input]`。

同一条提示覆盖其余所有失败 —— 没有附件存储、文件读不了、超过 20 MB、不支持的媒体类型。**这里的任何失败都不会让委派失败**；这一次运行产出的答案始终保留。

**后台调用拿到的是路径，不是图片。** 前台委派返回图片块，模型**看得到**那张图。`run_in_background` 的委派返回的是 job id，而经由 `job_output` 读回的一切**按契约都是字符串** —— 所以它的图片改为在文字里报告路径：`[1 image: /Users/…/shot.png]`。无论哪种方式，文件都在本机上。**想让模型真正看到截图，就用前台委派。** 协议本身接受 `input_image`、`local_image`、`image_url` 甚至音频，但本工具目前只发文字。在这一点改变之前，请在 prompt 里**写出路径**：Codex 会用它自己的图片工具打开那个文件，这一点已验证 —— 只给路径让它描述一张截图，它读出了图上列出的各个 provider。

## 在 profile 里覆盖这一行

本包声明的这一行是一个 bundle patch。想要不同设置的 profile 会添加一行**同 `id`** 的条目，而加载器会**把整个 `config` 映射替换掉**：它遍历 patch 的顶层字段逐个赋给目标，而 `config` 正是其中之一。它**不做深合并**，也**不合并数组**。

所以**每个字段都必须重述**，否则它就没了：

```yaml
# ✗ `presets` 没了，工具也就没了。这一行照样挂载 —— 只是不匹配任何 preset，
#   于是 `subagent_codex` 在任何会话里都不会出现。
- id: codex-pro
  config:
    runTimeoutMs: 5400000

# ✓ 整份映射，每个字段都在
- id: codex-pro
  name: 'dsh-subagent-codex-pro'
  config:
    providerName: codex-pro
    presets: [daily, heavy]
    runTimeoutMs: 5400000
```

这种失败**安静得最糟糕**：`id` 匹配不到任何条目、或 `name` 与目标不一致的 patch，会被**警告后跳过**，而不是报错；而丢掉 `presets` 的 config **照样挂载**，只是不为任何会话服务。本插件写进 `~/.dsh/codex-pro.log` 的那行 `apply` 会列出它**实际收到**的 presets —— 要核查就看那一行：

```
apply: v0.7.0 provider "codex-pro" registered … timeout=5400000ms; presets=["daily","heavy"]
                                                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^
```

## 线程生命周期

过去每次委派都开一个**临时 thread** —— app-server 在连接结束时把它删掉，所以**没有任何东西可以列出或续接**。`threadMode` 让你来选：

```yaml
- id: codex-pro
  config:
    threadMode: session       # ephemeral（默认）| persistent | session
    runTimeoutMs: 600000      # 单次委派的期限；0 表示不限制
```

调用可以自己指定 `timeout_ms`，它**覆盖**该次委派的配置默认值 —— 填 `0` 表示**不设期限**。这正是让期限**能在提示词里用起来**的关键：发布冒烟需要几十分钟，一次快速查证不需要，而模型**能说出这次是哪种**，因为这个值是**参数**而不是文件里的一个数。

**卡住的委派在外部是完全看不见的。** job 一直停在 `running`，会话一直等，日志里什么都没有 —— 而一次卡住的模型请求，从外面看就是这样。`runTimeoutMs` 是一次完整委派的期限，并且**覆盖启动阶段**：`initialize`、`thread/start`/`thread/resume`、`thread/name/set` 和 turn 共用同一个派生取消信号。到点就取消运行，在**独立的有限宽限期**内清理进程范围，并在结果里写明 `codex-pro: the delegation exceeded its 600000 ms deadline and was cancelled`。默认十分钟；填 `0` 恢复无限等待。

超时、调用方取消、协议失败、进程意外退出是不同类别；只会结算一次，teardown 幂等。自动修复 resume 时新建的 thread 共用原始绝对期限，不会重新拿一个完整超时。

**清理以实际受管范围为准。** POSIX上guardian作为独立进程组leader，Codex在同组运行；创建时建立IPC lifeline，调用方突退会触发guardian有界收尾。正常调用方仍核对整个组消失。真实Codex与guardian的退出事实分别保留，未知不补exit 0。Windows Host旧路径只管理直接进程，machine入口仅支持POSIX。详见[machine协议](machine.md#cancellation-and-process-ownership)。

| | |
|---|---|
| `ephemeral` | 一次性运行。不会留下任何 Codex CLI 或 Codex 应用能列出的东西。 |
| `persistent` | 每次委派都得到一条持久 thread：写入 `~/.codex/sessions/`，两边都能列出，也能续接。 |
| `session` | 每个 Agent 会话共用一条持久 thread —— 十次委派只留一条 thread，且第一次之后的每次调用都续接同一段对话。 |

单次调用可以用 `thread_mode` 覆盖这个选择，也可以用 `thread_id` 续接它自己指定的那条 thread。持久模式的结果末尾会带上 thread id：

```
[codex thread 01a1212b-79cf-7241-8892-896094fad3d6 · persistent · pass it as thread_id to continue]
```

0.165 上续接**不会忽略调用方的选择**：`model`、`cwd`、`permission_mode` 会作为 `thread/resume` 覆盖发送，并与响应里的有效配置比较。`reasoning_effort` 仍是每轮设置，续接时继续有效。对**记住的 session thread**，配置不兼容就换一条新 thread（共用同一期限）；对**显式 `thread_id`**，不兼容会明确报错，而不是悄悄换一条。

**有两件事由 app-server 决定，都是实测出来的。** 还没跑过 turn 的 thread **无法续接** —— 它会回 `no rollout found` —— 所以一条 thread 只有在完成第一次 turn 之后才可续接。另外，**Codex 应用只在 originator 恰好是 `Codex Desktop` 时才会列出该 thread**，那是它客户端过滤用的唯一取值；`originator` 就是设置它的，默认即该字面量。改成别的值就是用**应用内可见性**换一个**诚实的名字**，而 Codex CLI 两种情况都能列出。

因为 originator 没法说明 thread 来自哪里，持久 thread 会通过 `thread/name/set` 命名为 `DSH · <本次调用的描述>` —— 这才是人在列表里看到的内容。

**一条 thread 同时只能承载一个 turn。** 同一会话同时发出的两条委派会都去争那条被记住的 thread，app-server 会以 `thread-store conflict: … already has an active writer` 拒绝第二条。所以 `session` 模式下的调用会**先检查**：若那条被记住的 thread 正被另一个委派使用，就跳过它，本次调用另起一条，并把这次跳过**写进日志**。并行工作照常进行 —— 只是不再共用一段对话，而这正是 `persistent` 本来的行为，于是该模式**退化为支持这种工作形态的那个模式**。要**顺序执行并让对话延续**就选 `session`；要**同时跑多条委派**就选 `persistent` 或 `ephemeral`。

**为什么它不只是"方便"。** 被续接的 thread 保持**同样的提示前缀**，于是端点的缓存持续命中。在 Codex 侧实测：**93–99% 的 input token 来自缓存**；同样的工作若走 plan-usage 路由实测为 **0%**，因为那条路由拒绝一切缓存控制。

## 后台运行与进度

一次委派要一分钟以上，所以只要 jobs 服务已加载（`@deepseek-ai/dsh-jobs`），`run_in_background` 就存在。它返回一个 job id：

```js
tools.subagent_codex({ description: "…", prompt: "…", run_in_background: true })
// → { kind: "background", jobId: "subagent-3" }   用 job_output 取回
```

子进程自己的活动会在发生时**追加到该 job 的输出环**里 —— 已完成的命令和文件改动，加上 Codex 的 `commentary` 消息 —— 所以 `job_output` 显示的是长委派**进行得怎么样**，而不只是它最后说了什么。

## 权限：包括只读 Review

0.8.0 默认改为 **workspace-write + never**。旧配置显式设置 full access 时保留
显式选择；未填写权限的配置使用新默认值。工具调用只能保持配置权限、收窄为
read-only，或从显式 full access 收窄为 workspace-write；其它变更须修改配置。

| 模式 | approvalPolicy | sandbox | 用途 |
|---|---|---|---|
| workspace-write | never | workspace-write | 默认实现任务 |
| read-only | never | read-only | 独立评审与只读检查 |
| dangerously-bypass-approvals-and-sandbox | never | danger-full-access | 仅显式配置 |
| approve-for-me | on-request | workspace-write | 兼容旧的审批reviewer策略 |
| never | never | 省略 | 兼容旧配置，不证明沙箱范围 |

machine入口只接受前三种明确沙箱模式。必需的有效cwd/model/approval/sandbox
字段缺失、类型错误或不一致时，发送任务前失败；完整sandbox policy保留在收据。
本轮effort只有请求被接受的证据，协议不返回effective effort，不能伪造回执。

## token usage 与限额

Codex 通过 `thread/tokenUsage/updated` 报告线程累计的 `total` 和最近一次模型调用的 `last`。一次委派可能调用模型多次，而 `thread/resume` 会把持久化的最新快照重放给新连接；把重放当成本次消耗是错的。

统计器把通知折叠成一次委派的报告：

- `run` 是相对观测 baseline 的增量，绝不是把通知快照相加。
- resume 的重放会作为 baseline，不计入本次消耗；即使 Codex 在 turn/start 请求之后才发送该快照也一样。当前 turn 已有 live 快照后，其他 turn 的快照仍保持不可归属。
- resume 没有重放就收到第一条 live 快照时，报告是 `partial`，不会凭空写 0。
- 重复快照不累计；异常通知、归属不明或计数回退标记 `partial`，不产生负数。
- 其他 thread/turn 的 usage 不加进来。
- 没有观测时是 `unknown` 且没有 `run`，不是假的 `0`；失败、超时或取消前已观测到的 usage 会保留在失败结果里。
- `cachedInputTokens` 是 `inputTokens` 的子集，`reasoningOutputTokens` 是 `outputTokens` 的子集；字段按 Codex 原样报告，绝不重复相加。

`account/rateLimits/updated` 作为 `rateLimits` 单独保存，不并入 token usage。二者都会出现在 `CodexRunOutcome` / `delegateOnce` 结果和诊断日志中。DSH 的 `SubagentResult` 与工具结果契约没有 `usage`/`rateLimits` 字段，所以 provider 和自定义工具**不发明宿主字段**：工具结果仍只有 content，后台 job 结果仍是契约规定的字符串。完整机器收据通过公开machine API/CLI取得；宿主diagnostic只保留有界元数据，不承载原始协议、输入或凭据。

## 结构化结果的校验

`output_schema` 的结果现在**失败即关闭**：JSON 不合法、不是对象、required/type/range 不满足，或 schema 使用本包无法校验的关键字，都会让运行报告错误/诊断，而不是静默省略 `structured`。校验器覆盖本工具接受的对象根 JSON Schema 子集；不支持的关键字明确报错，不假装校验过。

当调用带 `output_schema` 时，答案就是 Codex 返回的纯 JSON 文本，**不会**追加 persistent thread 标记；thread id 另行报告并写入诊断日志。人类可读的普通答案仍然保留续接 thread 所需的标记。

## 验证层次

0.8.0新增guardian、公开machine入口与实际npm tarball安装检查，CI覆盖Ubuntu/macOS与Node22/24。以下真实模型记录来自已安装的 Codex **0.165.0**，属于 0.8.0 发布验证；覆盖的是用例使用的显式权限模式，不代表所有插件默认值。

1. **离线/封闭**：默认 `npm test`。用真实协议类和真实子进程驱动脚本化 fake app-server，覆盖启动卡死、turn 卡死、调用方取消、提前退出、resume、usage 重放、重复、只读权限、结构化校验、进程组后代和幂等 teardown。不调用模型，不碰 Codex 账号。
2. **真实 Codex app-server**：已用安装的 Codex **0.165.0** 跑 live app-server 用例（`CODEX_SUBAGENT_LIVE=1`），**4/4 通过**：覆盖 model + effort、显式权限模式、persistent thread 带显式 model/cwd/read-only 覆盖续接（含 usage 重放和 effective 配置校验），以及 `output_schema` 解码；另做了 `workspace-write` 默认权限和 `approve-for-me` 的真实检查。单独的 `codex exec` live 用例也通过（该文件 20/20，其中一次真实 CLI 调用）。官方 **0.166.0** 的 `ThreadResumeParams`、`ThreadResumeResponse`、`ThreadTokenUsage`、`token_usage_replay.rs` 已审阅，但没有执行 0.166 runtime。
3. **真实 DSH desktop 端到端**：仍未运行。实现保持现有 DSH provider/tool/job 契约；桌面 smoke 是唯一未执行的验证层。本轮未修改用户全局 Codex 登录或配置。

## 能力

| | 状态 |
|---|---|
| 每次调用的 `model` / `reasoning_effort` | ✅ |
| 返回最终消息 | ✅ |
| 本次运行产生的图片（截图、看过的文件） | ✅ 当调用方的模型路由接受图片时 |
| 交给本次运行的图片（`images`，绝对路径） | ✅ |
| schema 强约束的答案（`output_schema`，或 harness 的行配置） | ✅ 本地校验 |
| `run_in_background` + 通过 `job_output` 看进度 | ✅ |
| 只读 Review 权限（`read-only`） | ✅ `approvalPolicy=never` + `sandbox=read-only` |
| token usage / model context window | ✅ 公开machine收据；DSH result/tool/job保持正式宿主格式 |
| 账号限额 | ✅ 与 token usage 分开；公开 machine 收据可见 |
| 带确认的进程范围清理 | ✅ POSIX；无法确认会明确报告 |
| 期限覆盖启动与 turn；区分用户取消 | ✅ |
| app-server 协议（握手、线程生命周期、批准决定） | ✅ |
| 交互式批准 | 按设计没有 —— 委派运行是无人值守的，和官方 provider 一样 |
| 可续接 / thread 复用 | ✅ `session` 复用一条；`thread_id` 可续接任意一条 |
| `maxDepth` / persona / `toolFilter` | ❌ 不适用 —— 见下 |

上面那三项拒绝**不是待补的缺口**。一次 Codex 委派是**叶子**：它**没有 DSH 子 agent**，所以"委派深度上限"没有东西可限。它的工具是 **Codex 自己的** —— shell、patch 工具、它自己的 MCP —— **不是本 harness 的**，而 **tool filter** 描述的是 DSH 工具，因此无从表达它们；要限制 Codex 请用它自己的配置。而 **persona** 是给子 agent 的系统指令，这里任务已经通过 `prompt` 给出。把任何一项声明成 `true`，都等于向 harness 承诺一个并不存在的强制力。

官方 provider 的配置与结果契约满足需求时，可以直接使用官方版本。本包增加逐调用模型与思考等级配置，并给外部编排器提供公开 machine 收据。兼容性按文档列明的 DSH/Codex 基线核验；上游更新后仍需重新验证协议契约。

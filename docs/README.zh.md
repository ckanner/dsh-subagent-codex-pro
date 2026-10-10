# dsh-subagent-codex-pro

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

Codex 协议本身**支持**这两个字段（`ThreadStartParams.reasoningEffort`、`TurnStartParams.effort`）；官方 provider 从不发送它们。已上报上游：<https://github.com/deepseek-ai/deepseek-harness/discussions/9115>

还有**第二个独立的缺陷**：在一个 provider 是外部的行（`codex-pro`）上启用 `modelSelectionSettings: true`，会让那一行**静默地**一个工具都不注册 —— 没有报错、没有日志、没有 preset 失败标记。一个除了这个开关之外完全相同的对照行却能正常注册。也写在那份报告里。

## 它改用什么办法

两层，都在本包自己的控制之内。

### 执行：和官方 provider 说同一套协议

`src/wire.ts` 与 `src/run.ts` 是官方 app-server 适配器的移植 —— initialize 握手、临时 thread、thread/turn 关联（包括在 `turn/start` 返回之前就到达的通知）、无人值守的批准决定、以及按 phase 选取终态答复 —— 只加了**两处**：

```js
// thread/start
{ cwd, ephemeral: true, ...(model ? { model } : {}), reasoningEffort, ...THREAD_PERMISSION_PARAMS[mode] }
// turn/start
{ threadId, input: [...], effort }
```

这两个字面量在官方适配器那 871 行里**一次都没出现过**。与源码有两处机械性差异：JSON-RPC 传输是本包自己的（`src/jsonrpc.ts`），以及 app-server 是作为 `<command> app-server --stdio` 从 `PATH` 启动的，而不是从 `@openai/codex` 的 manifest 启动。`src/codex-exec.ts`（更早的 `codex exec` 路径）保留且有测试，但**未使用**。

### 工具注册：用它自己的 context

插件**自己**注册委派工具，在 `agent/created` 时注册进该 Agent 自己的 context —— 也就是 `dsh-plugin-lcu` 给它工具用的那条路：

```ts
ctx.on('agent/created', ({ agent }) => { if (!presetAllows(agent)) return; serve(agent) })
ctx.on('agent-preset/selected', (sessionId, preset) => { … })
// serve(): agent.ctx.tools.register(createCodexTool({ … }))
```

这样就把 harness 的 preset 行机制**完全排除在路径之外**。preset 不需要任何自己的行：`presets` 只声明哪些已确定的 Agent preset 会拿到这个工具 —— 这里是 `daily` 和 `heavy`。

因为工具名是固定的，官方 `tool-subagent-codex` 行在这些 preset 里被**禁用**。两行在同一个 Agent scope 里注册同名工具会冲突：后一次注册抛错，它的工具会**静默地永不出现**。

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
npm install
npm run typecheck
npm test                                  # argv + 工具 schema 用例；真实用例跳过
CODEX_SUBAGENT_LIVE=1 npm test            # 额外用 gpt-6-astra + xhigh 真跑一次
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

一次已验证的端到端运行：30 秒墙钟时间，模型的 `PROBE_OK` 作为工具结果返回。真实 app-server 运行也由 live 测试覆盖 —— 它开一个带 `reasoningEffort` 的 thread，以及一个带 `effort` 的 turn。

## 线程生命周期

过去每次委派都开一个**临时 thread** —— app-server 在连接结束时把它删掉，所以**没有任何东西可以列出或续接**。`threadMode` 让你来选：

```yaml
- id: codex-pro
  config:
    threadMode: session       # ephemeral（默认）| persistent | session
```

| | |
|---|---|
| `ephemeral` | 一次性运行。不会留下任何 Codex CLI 或 Codex 应用能列出的东西。 |
| `persistent` | 每次委派都得到一条持久 thread：写入 `~/.codex/sessions/`，两边都能列出，也能续接。 |
| `session` | 每个 Agent 会话共用一条持久 thread —— 十次委派只留一条 thread，且第一次之后的每次调用都续接同一段对话。 |

单次调用可以用 `thread_mode` 覆盖这个选择，也可以用 `thread_id` 续接它自己指定的那条 thread。持久模式的结果末尾会带上 thread id：

```
[codex thread 01a1212b-79cf-7241-8892-896094fad3d6 · persistent · pass it as thread_id to continue]
```

续接时会**忽略** `model` 和 `reasoning_effort`：二者都是 `thread/start` 的参数，而被续接的 thread 保留它创建时的取值。每轮的 `effort` 仍然有效。

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

## 能力

| | 状态 |
|---|---|
| 每次调用的 `model` / `reasoning_effort` | ✅ |
| 返回最终消息 | ✅ |
| `run_in_background` + 通过 `job_output` 看进度 | ✅ |
| app-server 协议（握手、线程生命周期、批准决定） | ✅ |
| 交互式批准 | 按设计没有 —— 委派运行是无人值守的，和官方 provider 一样 |
| 可续接 / thread 复用 | ✅ `session` 复用一条；`thread_id` 可续接任意一条 |
| 深度限制、persona、outputSchema、toolFilter | ❌ 未实现 |

**在协议保真度重要的场合，官方 provider 仍是更好的选择。** 本包存在，是因为它表达不了上面那两个选择；上游能表达之后，本包就该退休。

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

## 线程生命周期

过去每次委派都开一个**临时 thread** —— app-server 在连接结束时把它删掉，所以**没有任何东西可以列出或续接**。`threadMode` 让你来选：

```yaml
- id: codex-pro
  config:
    threadMode: session       # ephemeral（默认）| persistent | session
    runTimeoutMs: 600000      # 单次委派的期限；0 表示不限制
```

调用可以自己指定 `timeout_ms`，它**覆盖**该次委派的配置默认值 —— 填 `0` 表示**不设期限**。这正是让期限**能在提示词里用起来**的关键：发布冒烟需要几十分钟，一次快速查证不需要，而模型**能说出这次是哪种**，因为这个值是**参数**而不是文件里的一个数。

**卡住的委派在外部是完全看不见的。** job 一直停在 `running`，会话一直等，日志里什么都没有 —— 而一次卡住的模型请求，从外面看就是这样。`runTimeoutMs` 是一次完整委派的期限：到点就取消这次运行、清理它的子进程，并在结果里写明 `codex-pro: the delegation exceeded its 600000 ms deadline and was cancelled`，而不是什么都没有。默认十分钟，对一类自述"要一分钟以上"的任务来说很宽裕；填 `0` 则恢复"无限等待"的旧行为。

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
| 本次运行产生的图片（截图、看过的文件） | ✅ 当调用方的模型路由接受图片时 |
| 交给本次运行的图片（`images`，绝对路径） | ✅ |
| schema 强约束的答案（`output_schema`，或 harness 的行配置） | ✅ |
| `run_in_background` + 通过 `job_output` 看进度 | ✅ |
| app-server 协议（握手、线程生命周期、批准决定） | ✅ |
| 交互式批准 | 按设计没有 —— 委派运行是无人值守的，和官方 provider 一样 |
| 可续接 / thread 复用 | ✅ `session` 复用一条；`thread_id` 可续接任意一条 |
| `maxDepth` / persona / `toolFilter` | ❌ 不适用 —— 见下 |

上面那三项拒绝**不是待补的缺口**。一次 Codex 委派是**叶子**：它**没有 DSH 子 agent**，所以"委派深度上限"没有东西可限。它的工具是 **Codex 自己的** —— shell、patch 工具、它自己的 MCP —— **不是本 harness 的**，而 **tool filter** 描述的是 DSH 工具，因此无从表达它们；要限制 Codex 请用它自己的配置。而 **persona** 是给子 agent 的系统指令，这里任务已经通过 `prompt` 给出。把任何一项声明成 `true`，都等于向 harness 承诺一个并不存在的强制力。

**在协议保真度重要的场合，官方 provider 仍是更好的选择。** 本包存在，是因为它表达不了上面那两个选择；上游能表达之后，本包就该退休。

# 结构化生命周期与只读恢复（lifecycle 1）

本契约在 **0.9.0** 中实现。公开
`dsh-subagent-codex-pro/machine` 结果协议仍为 1；lifecycle 是另行版本化的
JavaScript 能力。单 JSON 输入的 CLI 与原 DSH Host/tool 输出保持原有方式。

## 显式启用

`runMachine(request, options)` 新增 `onLifecycle(event)` 与
`recoveryDirectory`。回调是程序持久化确认：Go 等调用者原子保存并 fsync 自己的
检查点之后才 resolve，失败则 reject；它不增加用户审批步骤。恢复目录必须是
现存物理父目录下的**全新绝对路径**，不是别名、符号链接或已有目录。每次 engine
invocation 使用自己的路径，不能按 thread ID 反复复用。目录存在会拒绝执行，
不会读取其中的 requestId 后自动重放。

任一选项启用后，独立进程组中的 machine supervisor 持有 native runner 与最终
持久化职责，先建立 IPC lifeline，再开始工作。调用者或其整个进程组被强杀时，
supervisor 拒绝正在等待的 ACK，取消原调用，等已有 Codex guardian 收束 native
进程组后保存实际回执。关闭进程本身不证明模型任务成功。

```js
import { runMachine, recoverMachine } from 'dsh-subagent-codex-pro/machine'
const receipt = await runMachine(request, {
  recoveryDirectory,
  signal: controller.signal,
  onLifecycle: event => engine.persistCheckpointAndFsync(event),
})
// 重启后使用自己已经保存的明确 runId；不扫描“最近一次”历史。
const recovered = await recoverMachine({
  protocol: 1, requestId: request.requestId,
  runId: savedCheckpoint.runId, recoveryDirectory,
})
```

`MACHINE_LIFECYCLE_VERSION=1`；公开 capability 为 `{version:1,
 durableJournal:true, readOnlyRecovery:true, threadReadyBeforeDispatch:true}`。
能力声明不等于当前账号、历史或机器已通过真实验收。

## 事件与证据强度

每个事件含 `lifecycleVersion:1`、`type:'lifecycle'`、`requestId`、`runId`、
从 1 连续递增的 `sequence`、`event`、`threadId`、`turnId`、`persistent`、
`configuration`、`dispatch`、`outcome`、`cleanupConfirmed`。
`persistent` 表示请求的历史模式，不能证明空 thread 已有可恢复 rollout。
配置对象保留真实 start/resume 来源、请求与有效配置、完整 sandbox policy 和
匹配结果。新 thread 的 `ephemeral` 必须由后端显式布尔值证明并与请求匹配；
resume 则必须被接受且有效 overrides 匹配。历史默认 effort 不冒充本 turn 的实际值。

| 事件 | 实际含义 |
| --- | --- |
| `thread-ready` | thread 与有效配置已核对，新 turn 尚未发送；等待调用者持久化 ACK。 |
| `dispatch-intent` | 准备提交这一明确 turn，仍未发送；等待 ACK。 |
| `dispatch-possible` | 在实际写入 turn 请求前保存并等待 ACK；发送与确认之间仍可能不确定。 |
| `turn-accepted` | 匹配的 turn/start 响应给出本次 turn ID；只是接受，不是完成。 |
| `terminal` | native 结果与清理事实已形成；请求 journal 时，完整原始回执已先 fsync。 |
| `cleanup-confirmed` | 只有实际确认 native 清理后才发；调用者可保存原调用的候选／guard／报告证据再 ACK。 |

终态通知在 native 收尾后交付，不声称更早的流式 terminal。两个终态事件携带同一
最终事实。原成功回执保存后，即使终态通知或 ACK 丢失，也不会把已完成的 native
调用改写成 cancelled。启动失败可以没有 thread-ready 而直接交付失败终态。

`execution.dispatch` 与事件分别表达 not-dispatched、possible、accepted。
possible 屏障拒绝时，即使测试观察到请求尚未写出，也保留 possible，不能靠错误
文本认领“零消耗／可重试”。进程清理完成不使 unknown 业务结果变成成功。
原调用 deadline 仍限制 native 启动和前置屏障；supervisor admission 及每次 ACK
另有 10 秒上限。调用者断开会立即拒绝 pending waiter，不会让清理无限等回调。

## 持久化与只读核对

supervisor 独占创建 0700 目录；0600 记录写入独占临时文件，fsync 后原子 rename，
再 fsync 目录。新建目录的父目录也 fsync。记录有精确 request/run 身份和 SHA-256
完整性校验；它是运行证据，不写 Go 的 state、预算或候选决策。

`recoverMachine` 只读取调用者给定且身份匹配的一个 journal。它不启动 CLI、不发
网络请求、不 resume、不查账号历史、不杀进程、不写文件、不重跑模型。必须给出
已知 runId；PID 是否存在不能证明进程所有权、清理或成功。

| status | 可以得出的结论 |
| --- | --- |
| terminal | 返回原始完整 receipt。仍须检查配置、业务结果、独立 cleanup 与用量；它可能是失败或 unknown。 |
| pending | journal 身份正确，但没有持久化终态；不证明 owner 还活着、turn 仍运行或重放安全。 |
| unknown | 缺失、不可读、损坏或身份不匹配；不猜派发和清理事实。 |

最新 `lifecycle` 在交付调用者**之前**落盘，所以它存在不证明 Go 已 ACK。只有 Go
自己的检查点能证明原清理边界的 candidate／guard／报告已保存；缺少这个证据时，
可以核对原消耗，不能重启后重采当前工作区当作旧验证。调用者死亡后通常可读到
supervisor 后续回执；若 supervisor 也在回执落盘前死亡，guardian 可能完成物理
清理，但结果仍必须保持未知。未知 runId、双 supervisor 丢失、逃离进程组或断电
超出 fsync 保证，都不构成 exactly-once。requestId 只是关联标识，不是幂等键。

调用者负责保留期限与删除：先完成一次且仅一次的状态应用／计量并满足审计期限，
再清理证据。不得通过删 journal 绕过 unknown。插件不自动扫历史或后台删档。
环境凭证不会被复制到记录中；原始模型输出可能包含用户敏感内容，仍须按任务的
私有证据和保留策略处理。

离线测试使用真实子进程验证 ACK、拒绝、损坏、独占、只读、整组 SIGKILL、终态
通知丢失及真实安装包入口；没有把这些测试冒充真实账号、缓存、质量或费用测量。
详见[验收记录](machine-lifecycle-validation.md)。

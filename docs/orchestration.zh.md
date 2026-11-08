# Flywheel 接入、需求准备与 Git 交付

本文区分插件能力与下游流程。0.8.0 提供 machine API/CLI；当前 0.9.0 源码候选
新增[可等待检查点与只读恢复](machine-lifecycle.zh.md)。原始接入分析的下游基线是
Flywheel 0.27.3；当前 Flywheel 的 driver、范围会话与恢复能力以其对应 PR 为准。
安装本插件本身不修改下游绑定，也不证明下游已经使用新能力。
本仓库 PR 不会替下游修改路由、推送业务代码、合并 main 或发布产品。

## 建议的接入方式

Go 引擎 → codex-pro-machine → 本包运行核心 → Codex app-server。

DSH 桌面仍是任务控制面，Go 持有任务状态、重试、预算、worktree、验收和 Git
交付。完整 Codex harness 由本包复用。复杂实现和需要 Codex 工具链的审查适合
这条通路；DSH 原生 Flash/GPT 路线仍可保留，不需要统一改成 Codex。

SDK rc.5 没有 external-subagent/start；Host 的 startActivation 要求真实父 Agent。
为调用 Codex 再启动一个父模型会增加一次模型循环，也不自动补足运行收据。
正式 machine 入口可以避免这个依赖，同时保留 requested/effective、usage、
取消、进程终态和清理证据。具体协议、失败行为与限制见 [machine.md](machine.md)。

下游必须实际实现 driver/worker、配置绑定、无推理诊断和跨进程回归，才能宣布
已经接通。它应校验协议版本、request/run 关联、实际sandbox policy及完成事实，
不能只判断 exit 0。正常 turn 后关闭长驻 app-server 的信号与调用方取消须分别处理。

## 需求准备选什么模型

这里是工程建议，不是经过本项目实测的模型排名：

| 场景 | 建议起点 | 原因 |
|---|---|---|
| 跨模块、架构约束多或需求不清楚 | GPT-6 Astra / high | 需求范围、接口和验收错误会传递到所有执行单元，优先投入判断与推理 |
| 范围清楚的日常功能或修复 | GPT-6.1 Sol / high | 在代码理解、约束梳理与响应成本之间取折中 |
| 单文件、小改动、已有清晰验收 | 当前 Flash 或 Sol 的常用配置 | 先验证是否足够，避免所有小任务都承担最高推理开销 |

初始 flywheel-new skill 使用宿主当前会话模型，不会自动切换到 loops.plan。
先在 DSH 选择支持工具调用的实际 provider/model；只选它实际支持的思考等级。
需求冻结后的运行中 Plan 仍按 Flywheel 配置，可以继续使用 Kimi CLI/high。
复杂需求可以让一个不同模型只读评审 Spec、边界和验收矩阵，但不默认反复多模型会审。

high 是建议基线。xhigh/max 应由代表性任务的质量增益、时间和额度决定，不能
仅凭“更高”就视为更优。API 支持某个等级，不等于当前 DSH adapter 暴露了它。
账户实际可用模型以本人的模型目录和授权为准；订阅额度也不等于无限调用。

依据：[OpenAI 模型指南](https://developers.openai.com/api/docs/guides/latest-model)、
[reasoning 与部署检查](https://developers.openai.com/api/docs/guides/deployment-checklist)。

## Worktree 与 PR 的建议时机

1. 从最新目标分支创建一个任务 feature branch 和独立 worktree。一个可独立
   交付的任务或里程碑对应一个 PR，避免每个内部 packet 都生成一个零碎 PR。
2. 在这个 worktree 中调研并准备 Spec/packets，审阅范围、测试和保护边界。
   已有有意义的提交后尽早开 Draft PR，让变更可见并启动远端 CI。
3. 让 Flywheel 的 cwd 指向该 feature worktree。它内部的 packet worktree
   提交汇回这个 feature branch；本地“主 checkout”不应被误解为 main 分支。
4. 持续保存和推送可审查的检查点。全部 L1/L2/L3、独立评审与 Git 持久化完成，
   并且远端 CI 对应当前提交通过后，再将 PR 标记 Ready。
5. 默认保留最终合并决策。用户已明确授权该任务自动合并时，可以启用 GitHub
   auto-merge，让 required checks/reviews 和分支保护决定真正的合并时机。
   多人频繁合并的仓库可用 merge queue；工作流需要支持 merge_group 事件。
6. 合并后核对目标分支 CI；发布/部署有自己的门禁与授权，不由本地 completed
   状态隐式触发。

worktree 解决工作区与 index 相互干扰，不是权限沙箱；仍要设置执行边界。
Draft、Ready、Merged、Published 是不同状态。模型说完成、某次测试绿灯、
Flywheel 的 local completed，都不能直接充当“允许合并 main”的判断。

你提到的 [mattpocock/skills](https://github.com/mattpocock/skills) 也可以作为
准备和审查方法的参考：当前 `to-spec` 整理已知需求与测试边界，`to-tickets`
按可独立验证的端到端行为拆分任务并明确依赖，`implement-spec` 使用 integration
branch、独立 worktree 和 Draft PR。Flywheel 可以吸收这些方法；运行时状态与
提交仍由 Go 持有，避免同时引入第二套编排状态机。

依据：

- [Git worktree](https://git-scm.com/docs/git-worktree)
- [GitHub Draft PR](https://docs.github.com/en/pull-requests/reference/pull-requests)
- [GitHub auto-merge](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)
- [受保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

## 覆盖率与真实验收

要求100%覆盖率时，应在项目实际测试工具里配置门禁，并写进任务包的L1命令。
覆盖率数值不能证明断言正确，还要审查边界案例、错误路径、集成与用户流程。
冻结验收不能由执行者削弱；真实模型、账号、桌面UI与系统沙箱的验证独立记录，
不能用fake app-server、DOM测试或CI runner代替用户机器结果。

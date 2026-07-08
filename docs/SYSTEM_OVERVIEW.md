# 系统总览：多 CLI 本地 Agent 体系

这份文档面向团队成员、试用者和开源读者，回答三个问题：

1. 这套系统解决什么问题
2. `lark-kiro-bridge` 和 `kiro-conduit` 分别负责什么
3. 为什么现在的最佳实践是“多 CLI + 分桶学习 + 多目标自适应”

## 一句话定位

- `lark-kiro-bridge`：把飞书对话变成一个可在本机项目上执行的低延迟 Agent 入口
- `kiro-conduit`：把大 spec 变成可并行执行、可审查、可合并的 DAG 编排流程
- `cursor-agent-cli`：便宜、快，适合简单任务与高吞吐实现
- `kiro-cli-acp`：更强，适合复杂实现、规划与审查

## 为什么要多 CLI

如果只接一个 CLI，就只能在“便宜”和“强能力”之间二选一。

多 CLI 的生产价值在于：

- 简单任务走便宜路线，控制成本
- 复杂任务自动升级，保证成功率
- planner / implementor / reviewer 各自选最合适的 runtime
- 将来可以继续接入更多本地 agent/editor CLI，而不重写主系统

## 两个项目怎么分工

### `lark-kiro-bridge`

适合：

- 飞书里的交互式对话
- 低延迟问答
- 单文件或轻量编辑
- 在线观测 runtime 命中、历史指标、adaptive 推荐

关键能力：

- session 管理
- runtime/profile 路由
- task bucket（`chat` / `review` / `plan` / `edit` / `conduit`）
- Dashboard 可视化

### `kiro-conduit`

适合：

- 大 spec 拆 DAG
- 多 worker 并行执行
- planner / implementor / reviewer 分角色编排
- 长时运行与合并前审查

关键能力：

- worktree 隔离
- 多角色 runtime 选择
- role bucket（`planner` / `implementor` / `reviewer`）
- report / metrics / adaptive routing

## 推荐默认生产策略

### CLI 层

- 简单任务：`cursor-agent-cli` + `Auto`
- 复杂任务：`kiro-cli-acp`

### Kiro 模型层

- simple：`fast` / `balanced`
- medium：`strong`
- hard：`max`

### 角色层

- planner：优先 `kiro-cli-acp`
- implementor：优先 `cursor-agent-cli`
- reviewer：优先 `kiro-cli-acp`

## 为什么要做分桶学习

不能把所有历史样本混在一起学。

例如：

- `review` 的最佳模型，通常不等于 `chat`
- `planner` 的最佳 runtime，通常不等于 `implementor`
- 审查经常给 FAIL，不代表 reviewer runtime 不可靠

所以系统现在按 bucket 分开统计、分开推荐、分开自适应。

## 为什么不只看成功率

只看成功率会天然偏向更贵、更慢、但偶尔更稳的路线，无法满足“生产可用 + 成本可控”。

现在推荐会综合：

- 成功率
- 平均耗时
- 平均改动规模
- 平均工具调用 / 重试
- 成本代理分

## rollout 建议

1. 先用 `suggest` 跑一段时间，积累样本
2. 再切 `apply-safe`
3. 只在明确收敛的桶上用 `apply-aggressive`
4. reviewer 永远优先稳定，不要一味省钱

## 阅读路径

- 想知道怎么落地配置：看 `runtime-routing-production.md`
- 想知道跨项目契约：看 `agent-runtime-spec.md`
- 想知道 bridge 内部实现：看 `ARCHITECTURE.md`
- 想知道 conduit 生产编排：去 `kiro-conduit/docs/runtime-routing.md`

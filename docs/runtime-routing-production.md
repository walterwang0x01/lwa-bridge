# 多 CLI 生产实践

这套方案的目标不是做一个“万能 Agent 平台”，而是把本地多 CLI 编排做成一条成本优先、扩展友好的生产链路。

## 设计原则

1. 简单任务优先免费或低成本引擎：默认走 `cursor-agent-cli` 的 `Auto`
2. 复杂任务才升级到 `kiro-cli`
3. 进入 `kiro-cli` 之后，再按复杂度和实时可用模型二次选模
4. 不硬编码假定模型名，始终以 `kiro-cli --list-models` 实时结果为准
5. 把“为什么这样选”记录下来，便于后续优化成本、速度和成功率

## 推荐分工

- `lark-kiro-bridge`
  - 适合交互式、低延迟、用户在飞书里连续追问的场景
  - 简单问答、轻量总结、单文件修改优先走 `Cursor Auto`
  - 多步骤、跨模块、架构调整、review 类任务优先走 `Kiro`

- `kiro-conduit`
  - 适合 DAG、并行 worker、无人值守执行
  - `implementor` 可以优先吃低成本 runtime
  - `reviewer` / `planner` 更适合稳定和更强模型

## 推荐默认策略

- CLI 路由
  - 简单：`cursor`
  - 复杂：`kiro`

- Kiro 模型路由
  - `simple`：优先较便宜的 Sonnet / Haiku 档
  - `medium`：优先 `claude-sonnet-5`
  - `hard`：优先 `claude-opus-4.8`

## 什么时候不要直接接入外部“最强项目”

不要直接把网上的通用 router 当成主系统替换掉，原因是你的核心价值来自这几个组合：

- 飞书入口
- 本地 CLI 执行
- 多 CLI 统一抽象
- 成本优先
- 可扩到更多 agent/editor CLI

最佳做法是：

- 保留自己的 runtime 抽象层
- 借鉴外部项目的路由、fallback、可观测性设计
- 不把主执行链路外包给一个你无法稳定控制的通用框架

## 后续建议

下一阶段最值得补的是：

1. 路由命中率、失败率、平均耗时、平均成本的统计面板
2. 基于历史成功率的自适应路由，而不只是规则路由
3. 新 CLI 接入协议：能力声明、模型发现、流式解析、session 续接、可观测性字段

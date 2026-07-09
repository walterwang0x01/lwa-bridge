# Lark Local Agent Workbench（LWA）— 对外介绍

> 30 秒版本：**在飞书里跑本机 Agent，简单任务用 Cursor，复杂任务用 Kiro；大 spec 交给 Conduit 并行编排。**

## 解决什么问题

云端 AI 编程助手（Cursor Web、Copilot、Devin 等）有两个结构性限制：

1. **碰不到你本机的私密项目目录**
2. **没有飞书 API 调度能力**（日程、文档、审批、消息）

同时，本地 Agent CLI 又面临另一个矛盾：**便宜的快但不稳，强的贵且慢**——只接一个 CLI，只能在成本和成功率之间二选一。

**LWA** 把这两类问题一起解决：飞书入口 + 多 CLI 智能路由 + 可观测 + 分桶自适应学习。

## 体系组成

| 层级 | 产品名（仓库） | 一句话 |
|------|----------------|--------|
| 体系 | **LWA** | 本地多 CLI Agent 生产工作台 |
| 飞书入口 | **Bridge**（lark-kiro-bridge） | 低延迟对话、轻量编辑、Dashboard 观测 |
| DAG 编排 | **Conduit**（kiro-conduit） | 大 spec 拆 DAG、分角色并行、合并前审查 |

两个仓库互补，不是竞争关系：

- 日常在飞书里问代码、改单文件、查状态 → **Bridge**
- 几十个 PR、多 worktree、长时无人值守 → **Conduit**（飞书里也可 `/conduit` 触发）

## 默认生产策略

```
简单任务  →  cursor-agent-cli + Auto     （便宜、快）
复杂任务  →  kiro-cli-acp                （稳、强）

planner   →  kiro-cli-acp
implementor → cursor-agent-cli
reviewer  →  kiro-cli-acp
```

系统会按任务桶（`chat` / `edit` / `review` / `planner` / `implementor` …）分开统计历史，综合**成功率、耗时、改动规模、成本代理**做自适应推荐——而不是把所有样本混在一个池子里学。

## 适合谁

- 已在用 **飞书** 协作、希望 Agent 直接操作本机 repo 的团队
- 需要 **成本可控** 的多 CLI 路由（不是永远用最贵模型）
- 有大 spec / 多 PR 并行需求、但不想手动管 5 个 worktree 的开发者
- 想要 **可观测**（Dashboard、metrics、`report`）而不是黑盒跑完才知道结果

## 不适合谁

- 想要纯云端 SaaS、不想在本机跑 CLI 的用户
- 期望一个万能编排器兼容所有 Agent 框架（LWA 先在 Kiro + Cursor 生态做深）
- 需要多机集群调度（当前定位是单机多进程 + git worktree）

## 快速开始

```bash
# Bridge：飞书入口
npm install -g lark-kiro-bridge
lark-kiro-bridge run

# Conduit：终端编排（也可从飞书 /conduit 触发）
pipx install kiro-conduit
kiro-conduit run --workspace my-workspace/ --adaptive-mode suggest
```

## 延伸阅读

| 文档 | 内容 |
|------|------|
| [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) | 体系总览、分工、分桶学习原理 |
| [runtime-routing-production.md](./runtime-routing-production.md) | Bridge 侧生产调参 |
| [Conduit runtime-routing](https://github.com/walterwang0x01/kiro-conduit/blob/main/docs/runtime-routing.md) | Conduit 侧角色路由与 adaptive |
| [README](../README.md) | Bridge 安装与飞书命令 |

## 对外一句话（可直接复制）

> **LWA（Lark Local Agent Workbench）** 让你在飞书里驱动本机多 CLI Agent：Bridge 负责对话与观测，Conduit 负责大 spec 并行编排；简单走 Cursor Auto，复杂自动升级 Kiro，并按任务桶持续学习最优路由。

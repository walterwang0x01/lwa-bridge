# LWA 跨项目路线图（2026 Q3 – 2027 Q2）

> 受众：维护者 / 贡献者 / 想参与规划的人
>
> 作用：在 **Bridge（lwa-bridge）** 与 **Conduit（lwa-conduit）** 之上，按季度排列「下一步做什么、为什么、怎么验收」。
>
> 本文**不替代**各仓库内部里程碑文档：
> - Conduit 实现节奏 → [`kiro-conduit/docs/ROADMAP.md`](https://github.com/walterwang0x01/lwa-conduit/blob/main/docs/ROADMAP.md)
> - Bridge 版本功能 → [`lwa-bridge/README.md`](https://github.com/walterwang0x01/lwa-bridge#路线图) 路线图章节

## 原则（全阶段不变）

1. **Runtime 与 Ingress 解耦** — 换 IM 不换编排；换 CLI 不换飞书卡片层（长期目标）
2. **分桶学习** — `chat` ≠ `review` ≠ `implementor`；禁止混池 adaptive
3. **多目标路由** — 成功率 + 耗时 + 改动 + 成本代理，不唯成功率
4. **渐进 rollout** — `suggest` → `apply-safe` → `apply-aggressive`；reviewer 永不激进省钱
5. **技术名稳定** — 对外 LWA / Bridge / Conduit；包名与 CLI 变更走 [REPO_RENAME_PLAN.md](./REPO_RENAME_PLAN.md) 决策门

## 基线（2026-07，已完成）

| 能力 | Bridge | Conduit |
|------|--------|---------|
| Runtime | `kiro-cli-acp`, `cursor-agent-cli` | 同左 + 角色级覆盖 |
| 路由 | smart + task bucket + adaptive | role bucket + adaptive |
| 观测 | Dashboard + taskHistory metrics | `report` + duration / verdict 分离 |
| 编排 | `/conduit` 子进程 | DAG + worktree + verifier |
| 品牌 | LWA 文档 + GitHub `lwa-*` | 同左 |

**成熟度估计**：架构方向 ~70%，团队生产「全自动零运维」~40%。

---

## 总览时间线

```
2026 Q3          2026 Q4          2027 Q1          2027 Q2
────────         ────────         ────────         ────────
巩固生产         第三 Runtime     第二 Ingress     多用户服务
apply-safe       配额路由         策略/审批层      Dashboard 可操作
Conduit M2       Ingress 抽象     Gemini 生产默认可选  审计导出
```

---

## 2026 Q3 — 巩固生产（当前季度）

**主题**：把已有能力从「能跑」推到「敢默认开」。

### Bridge

| 项 | 交付物 | 验收标准 |
|----|--------|----------|
| Adaptive 升级 | 文档 + `runtime-config.apply-safe.json` + Dashboard 就绪条 | ✅ 模板与就绪 API |
| Metrics 告警（本地） | Dashboard 低成功率行高亮 + `metricsAlerts` | ✅ |
| Runtime 契约 | 更新 `agent-runtime-spec.md`：未来 runtime 扩展字段 | Conduit 与 Bridge schema 对齐 |

### Conduit

| 项 | 交付物 | 验收标准 |
|----|--------|----------|
| **M2 实战** | 真实大 spec（≥8 PR）端到端 | 节省时间 ≥50%，见 Conduit ROADMAP |
| Reviewer 指标稳定 | `execution_ok` / `verdict_pass` 分桶 report | FAIL 审查不拉低 runtime 成功率 |
| PyPI 首发（可选） | `kiro-conduit` 0.1.0 | `pipx install` 文档路径跑通 |

### 跨项目

| 项 | 交付物 | 验收标准 |
|----|--------|----------|
| 配额调研 Spike | `docs/spikes/quota-probe.md`（设计，可不写代码） | 列出 Cursor / Kiro / Gemini 可探测 API 与 fallback 策略 |
| 品牌 | 评估是否引入副品牌 **LAW**（Local Agent Workbench） | Issue 讨论结论记录在 `#18` 同级 |

**本季度不做**：新 IM 渠道、Gemini 正式接入、多用户服务器。

---

## 2026 Q4 — 第三 Runtime + Ingress 抽象

**主题**：降低成本天花板，并为多 IM 做结构准备。

### 第三 Runtime：`gemini-cli`（P0） — 🚧 适配器已接入（需本机安装 `gemini`）

| 步骤 | 内容 |
|------|------|
| 协议调研 | Gemini CLI 输出格式、OAuth / API key、日配额 |
| Bridge 适配器 | ✅ `RuntimeKind` + `geminiCliRuntime` + stream parser |
| Conduit 适配器 | ✅ `gemini_cli.py` implementor / reviewer / planner |
| 路由策略 | `simple + high-volume → gemini`（配置 `profiles.gemini` + `/runtime gemini`） |
| metrics | ✅ cost proxy 三档分列 |
| 配额探测 | 见 `spikes/quota-probe.md`（待实现） |

**验收（剩余）**：本机 `npm i -g @google/gemini-cli` 后跑通一条 chat turn；adaptive 分桶出现 gemini 推荐行。

### 配额感知路由（P0）

```
启动 / 定时 ──► QuotaProbe ──► RuntimeRegistry（带 remaining 权重）
                                    │
                    额度不足 ────────┴──► fallback 下一档 runtime
```

| 组件 | 位置 | 说明 |
|------|------|------|
| `QuotaProbe` 接口 | Bridge `src/runtime/` | 各 CLI 实现 `probe(): Promise<QuotaStatus>` |
| 路由集成 | `router.ts` / Conduit `model_router.py` | 过滤 `remaining <= 0` 的 profile |
| 用户可见 | `/status` 或 Dashboard | 展示各 CLI 本月/本日剩余 |

**验收**：Kiro credits 用尽时，chat bucket 自动落到 Cursor 或 Gemini，并写日志。

### Ingress 抽象（P1，设计 + 飞书迁移第一步）

目标目录结构（示意）：

```
src/
  ingress/
    types.ts          # NormalizedMessage, NormalizedReply, ChannelId
    lark/             # 现有飞书逻辑迁入
    registry.ts
  core/
    dispatcher.ts     # 只认 ingress 类型，不认 Lark SDK
```

**验收**：飞书行为无回归；新增 `ingress/mock` 可在无飞书凭据下跑集成测试。

**本季度不做**：Teams / Telegram 正式上线。

---

## 2027 Q1 — 第二 Ingress + 策略层

**主题**：证明 LWA 不绑飞书；团队可治理。

### 第二 Ingress（二选一，建议顺序）

| 优先级 | 渠道 | 理由 |
|--------|------|------|
| P0 候选 A | **Slack** | 开发者多、Bot API 成熟、卡片类似 |
| P0 候选 B | **Microsoft Teams** | 企业客户多 |
| P1 | Telegram | 个人开发者 / 通知型 |
| P2 | 企业微信 / 钉钉 | 国内政企，合规与 API 成本高 |

**验收**：同一 Bridge 进程（或同配置）可配置 `ingress: lark | slack`；session / runtime 路由复用。

### 策略与审批层（P1）

| 能力 | 说明 |
|------|------|
| 预算帽 | 每 chat / 每用户 日 credits 上限 |
| 危险操作闸门 | bash、delete、`--merge` 可配置人工确认 |
| 审计事件 | 结构化日志：who / channel / runtime / model / outcome |

**验收**：超预算拒绝新 turn；审计 JSON 可导入 ELK（不要求内置 ELK）。

### Conduit

| 项 | 说明 |
|----|------|
| CI 触发 | GitHub Action 示例：PR 评论触发 `kiro-conduit run` |
| DAG 草稿（可选） | LLM 生成 DAG 草稿 + 人工 edit，不自动执行 |

---

## 2027 Q2 — 多用户服务化

**主题**：从「个人本机工作台」到「小团队可共享部署」。

### Bridge v1.0 目标（对齐 README 路线图）

| 项 | 说明 |
|----|------|
| 集中部署 | 单服务多 `appId` / 多用户配置隔离 |
| Dashboard 可操作 | 网页触发任务、终止、查看 conduit 进度 |
| 身份 | 渠道用户 ID → 内部 principal；与 access control 统一 |

### Conduit

| 项 | 说明 |
|----|------|
| 远程 worker（探索） | SSH / 队列 worker，不阻塞 Q2 交付 |
| 内存 / 并行调优 | 5 worker ≤4GB 目标（见 PRD） |

### 品牌

若已接 ≥2 个 IM：对外主推 **LAW（Local Agent Workbench）**，LWA 作兼容简称。

---

## Runtime 扩展 backlog（按优先级）

| Runtime | 免费额度（2026-07 参考） | 优先级 | 备注 |
|---------|-------------------------|--------|------|
| `cursor-agent-cli` | Auto / 订阅额度 | — | 已接入 |
| `kiro-cli-acp` | ~50 credits/月 Free | — | 已接入；适合 planner/reviewer |
| `gemini-cli` | ~1000 req/天（以官方为准） | **P0 Q4** | 最佳第三选择 |
| `opencode` | 工具免费 BYOK | P2 | 统一前端挂多 key |
| `github-copilot-cli` | Copilot Free 有限 | P3 | GitHub 生态 |
| `claude-code` | 无免费档 | P4 | 能力强，订阅贵 |
| `codex-cli` | Plus/API | P4 | 与 Cursor 重叠 |

接入任一 runtime 的**最小清单**：

- [ ] `RuntimeKind` + 适配器（Bridge + Conduit）
- [ ] `agent-runtime-spec.md` 协议表
- [ ] `QuotaProbe` 实现
- [ ] metrics `cost_score` 更新
- [ ] bucket 样本 ≥30 后再参与 adaptive

---

## 与「最佳生产实践」的差距表

| 实践 | 现在 | Q3 结束 | Q4 结束 | Q2 2027 |
|------|------|---------|---------|---------|
| 多 CLI 路由 | ✅ | ✅ | ✅ + Gemini | ✅ |
| 分桶 adaptive 自动应用 | suggest | apply-safe 部分桶 | 多数桶 | 全面 |
| 配额 fallback | ❌ | 设计 | ✅ | ✅ |
| 多 IM | 仅飞书 | 仅飞书 | 抽象就绪 | 2 渠道 |
| 审批 / 审计 | 部分（merge 确认） | 文档化 | 基础策略 | 完整 |
| 多用户部署 | ❌ | ❌ | ❌ | v1.0 |
| Conduit 生产大 spec | M2 进行中 | ✅ | 稳定 | 稳定 |

---

## 如何参与

1. 先读 [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) · [PITCH.md](./PITCH.md)
2. 认领上表中带 **P0** 的 Issue（或新建并标 `roadmap-q3` / `roadmap-q4`）
3. Runtime 扩展务必先更新 `agent-runtime-spec.md` 再写适配器
4. 大改动开设计 Issue，避免直接改飞书耦合路径

## 相关文档

| 文档 | 内容 |
|------|------|
| [runtime-routing-production.md](./runtime-routing-production.md) | Bridge 生产调参 |
| [Conduit runtime-routing](https://github.com/walterwang0x01/lwa-conduit/blob/main/docs/runtime-routing.md) | 角色路由 |
| [REPO_RENAME_PLAN.md](./REPO_RENAME_PLAN.md) | 包名 / CLI 迁移 |
| [Conduit ROADMAP](https://github.com/walterwang0x01/lwa-conduit/blob/main/docs/ROADMAP.md) | Conduit M0–M3 |

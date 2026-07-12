# 多 CLI 生产实践（完整版）

**Lark Local Agent Workbench（LWA）** 的生产路由方案：成本优先、角色分桶、可观测、可自适应。对外介绍见 [`PITCH.md`](./PITCH.md)。

核心产品约定：

| 组件 | 角色 |
|------|------|
| **Bridge**（lark-kiro-bridge） | 飞书交互入口、低延迟对话、任务路由与观测面板 |
| **Conduit**（lwa-conduit） | DAG / 并行编排、无人值守执行、角色级 runtime 选择 |
| `cursor-agent-cli` (`agent`) | 便宜、快，适合简单实现与轻量任务（`Auto`） |
| `kiro-cli-acp` (`kiro-cli`) | 更强能力，适合复杂实现、规划、审查 |

---

## 1. 设计原则

1. **简单任务优先免费 / 低成本**：默认走 `cursor-agent-cli` 的 `Auto`
2. **复杂任务才升级到 `kiro-cli`**
3. **进入 Kiro 后再二次选模**：按复杂度和 `kiro-cli --list-models` 实时可用列表选
4. **不硬编码模型名**：永远以本机实时列表为准
5. **按任务类型分桶学习**：`chat` / `review` / `plan` / `edit` / `conduit`（bridge），`planner` / `implementor` / `reviewer`（conduit）
6. **多目标评分，不只看成功率**：成功率 + 耗时 + 改动规模 + 成本代理（+ 重试）
7. **审查结论 ≠ runtime 失败**：`verdict FAIL`（审出问题）不能当成模型/执行失败

---

## 2. 两层路由（永远先 CLI，再模型）

```text
prompt / role
    │
    ├─① CLI 路由
    │     simple  → cursor-agent-cli (Auto)
    │     complex → kiro-cli-acp
    │
    └─② 若命中 kiro
          complexityScore
            ├─ simple  → fast / balanced tier
            ├─ medium  → strong tier
            └─ hard    → max tier
          再从 --list-models 实时结果里 pickFirst
```

### Bridge（飞书侧）推荐默认

- `runtime.default = "auto"`
- `runtime.router.mode = "smart"`
- `simpleProfile = "cursor"`，`complexProfile = "kiro"`
- `modelRouting.cursor.model = "Auto"`（固定）
- `modelRouting.kiro.mode = "smart"`

### Conduit（编排侧）推荐默认

| Role | 默认 runtime | 说明 |
|------|--------------|------|
| `implementor` | `cursor-agent-cli` | 吞吐优先、成本优先 |
| `planner` | `kiro-cli-acp` | 拆分 durability 优先 |
| `reviewer` | `kiro-cli-acp` | 审查能力优先 |

同一 DAG run 内单角色保持 homogeneous runtime，不要混着用。

---

## 3. 任务分桶（Task Buckets）

### Bridge 分桶

`classifyTaskBucket()` 基于 command / prompt 归类：

| Bucket | 典型触发 |
|--------|----------|
| `chat` | 普通对话、轻量问答 |
| `review` | 审查 / doctor / 代码评审类 |
| `plan` | 规划、DAG、工作流拆分 |
| `edit` | 多文件修改、重构、patch |
| `conduit` | `/conduit` 编排 |

任务历史会写入 `taskBucket`；metrics 与 adaptive 推荐**按桶隔离**，避免「chat 历史污染 review」。

### Conduit 分桶

| Bucket | 来源 |
|--------|------|
| `implementor` | `run` 并行执行结果（兼容读取旧 `conduit-run`） |
| `planner` | `plan` 成功 / 失败落盘 |
| `reviewer` | per-task semantic review + integration review |

---

## 4. 自适应路由（Adaptive）

### 模式

| Mode | 行为 |
|------|------|
| `off` | 完全不用历史 |
| `suggest`（默认） | 只建议，不改默认选择 |
| `apply-safe` | 样本够、成功率够高时才覆盖（保守） |
| `apply-aggressive` | 有推荐就覆盖（更激进） |

Bridge 配置：`modelRouting.kiro.adaptiveMode`  
Conduit CLI：`--adaptive-mode`（`run` / `plan` / `report`）

### 多目标分数（要点）

综合分大致考虑：

- 成功率（主权重）
- 平均耗时 / 重试（速度）
- 改动规模 / 工具调用（噪声惩罚）
- 成本代理（`cursor Auto` 高，`opus` 低）

Dashboard / `lwa-conduit report` 会展示 `score`、样本数、按桶推荐。

### Reviewer 特殊规则

指标分两列概念：

- `execution_ok` / `passed`：runtime 是否跑通（超时、崩溃 = 失败）
- `verdict_pass`：审查结论（`FAIL` = 找到问题，**正常产出**）

自适应**只学 execution**，不会因为「经常审出 FAIL」而错误降权 reviewer 模型。

---

## 5. 可观测性

### Bridge

- 任务历史：`taskBucket`、`runtimeKind`、`model`、`complexityScore`
- Dashboard「Runtime 指标」：按桶聚合，含 Score / Rate / Avg Duration
- Adaptive 推荐条：preferred runtime/model + score + samples

### Conduit

- `.lwa-conduit/runtime-metrics.json`
- `lwa-conduit report --base-repo <repo>`
- 运行日志记录各角色实际命中的 runtime / model
- report 打印每桶：`success_rate` / `avg_files` / `avg_duration` / `score` / （reviewer）`verdict_pass_rate`

---

## 6. 推荐生产配置

完整例子见 [`runtime-config.example.json`](./runtime-config.example.json)。

起步策略：

1. Bridge：`smart` 路由 + Kiro `smart` 选模 + `adaptiveMode: "suggest"`（先观察 1~2 周）
2. Dashboard「Runtime 指标」查看 **apply-safe 就绪** 与 **低成功率告警**
3. 样本稳定后：交互侧可切 `apply-safe`（见 [`runtime-config.apply-safe.json`](./runtime-config.apply-safe.json)）
4. Conduit：implementor 用 cursor，reviewer/planner 用 kiro；`--adaptive-mode suggest`，确认后按桶 `apply-safe`

### apply-safe 切换检查单

| 条件 | 阈值 | 在哪看 |
|------|------|--------|
| 每桶样本 | ≥ **8**（门禁）/ 建议 ≥ **30**（rollout） | Dashboard「apply-safe 就绪」 |
| runtime 成功率 | ≥ **90%** | 同上 `canApplyRuntime` |
| Kiro model 成功率 | ≥ **90%** | 同上 `canApplyModel` |
| 无劣化组合 | 无样本≥3 且成功率&lt;75% 的行 | Dashboard 红色告警行 |

门禁常量（代码）：`src/runtime/adaptive.ts` — `APPLY_SAFE_MIN_SAMPLE = 8`，`APPLY_SAFE_MIN_SUCCESS_RATE = 0.9`。

**切换步骤**：

1. 复制 [`runtime-config.apply-safe.json`](./runtime-config.apply-safe.json) 中 `modelRouting.kiro.adaptiveMode` 到你的 `config.json`
2. `lark-kiro-bridge restart`
3. 观察 3–5 天：失败率未升、告警行未增 → 保持；否则回退 `suggest`

`review` bucket：**不要**用 `apply-aggressive`；reviewer 优先稳定。

```bash
# Conduit：实现便宜优先，审查能力优先
lwa-conduit run \
  --workspace my-workspace/ \
  --runtime-kind cursor-agent-cli \
  --kiro-cli agent \
  --reviewer-runtime-kind kiro-cli-acp \
  --reviewer-bin kiro-cli \
  --adaptive-mode suggest \
  --kiro-simple-tier balanced \
  --kiro-medium-tier strong \
  --kiro-hard-tier max

# 查看分桶指标与推荐
lwa-conduit report --base-repo .
```

飞书侧可用：`/runtime cursor` | `/runtime kiro` 手动锁定会话 runtime。

---

## 7. 什么时候不要“接外部最强 router 替换自己”

不要直接把网上的通用 router 当成主系统替换掉。你的价值在于：

- 飞书入口
- 本地多 CLI 执行
- 角色化编排（conduit）
- 成本优先策略
- 可扩到更多 agent / editor CLI

正确做法：

- **保留**自己的 `AgentRuntime` / Runtime Registry 抽象
- **借鉴**外部的路由、fallback、可观测设计
- **不要**把主执行链路外包给无法控制的通用框架

---

## 8. 扩展新 CLI 的检查清单

接入第三个 CLI（如某个新 agent / editor）时至少补齐：

1. Runtime kind 命名（清晰、稳定）
2. Session ID 前缀：`{kind}:{nativeId}`
3. 能力发现（是否可用、模型列表）
4. 流式解析 / 统一事件映射到 UI
5. 写入 metrics：`taskBucket`、`runtimeKind`、`model`、耗时、成败
6. 成本代理分（进多目标评分）
7. 文档与 example config

---

## 9. 运维建议

- 先 `suggest`，后 `apply-safe`；`apply-aggressive` 只给熟悉系统的维护者
- 复杂任务过早升级：提高 complexity / medium / hard threshold
- 成本过高：simple/medium 往 `fast`/`balanced` 调，implementor 保持 cursor
- 成功率掉：medium/hard 往 `strong`/`max`，reviewer 保持 kiro
- 定期看 Dashboard / `report`：按桶看 score，而不是全局混看

相关规范：[`agent-runtime-spec.md`](./agent-runtime-spec.md)  
Conduit 侧同主题：`lwa-conduit` 仓库的 `docs/runtime-routing.md`

面向团队/开源读者：[`PITCH.md`](./PITCH.md) · [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md)

# Agent Runtime 规范

多 CLI 兼容层的跨项目约定（`lark-kiro-bridge` TypeScript + `lwa-conduit` Python）。

## Runtime kinds

| kind | binary | 协议 |
|------|--------|------|
| `kiro-cli-acp` | `kiro-cli` | ACP JSON-RPC over stdio |
| `cursor-agent-cli` | `agent` | NDJSON `stream-json` via `--print` |
| `gemini-cli` | `gemini` | NDJSON `stream-json` via `-p`（headless） |

## Session ID

存储格式：`{kind}:{nativeId}`，例如 `cursor-agent-cli:16255d95-...`。

切换 runtime 后不跨引擎续接 session。

## lark-kiro-bridge 配置

```json
{
  "runtime": {
    "default": "auto",
    "profiles": {
      "kiro": { "kind": "kiro-cli-acp", "bin": "kiro-cli" },
      "cursor": { "kind": "cursor-agent-cli", "bin": "agent", "force": true, "model": "Auto" },
      "gemini": { "kind": "gemini-cli", "bin": "gemini", "force": true, "model": "auto" }
    },
    "router": {
      "mode": "smart",
      "lark": { "simpleProfile": "cursor", "complexProfile": "kiro" }
    },
    "quota": {
      "cacheTtlMs": 600000,
      "dashboardRefreshMs": 60000,
      "monthlyLimits": { "kiro-cli-acp": 50 },
      "fallbackByBucket": {
        "chat": ["cursor", "gemini", "kiro"],
        "review": ["kiro", "gemini", "cursor"]
      }
    }
  },
  "modelRouting": {
    "cursor": { "mode": "fixed", "model": "Auto" },
    "kiro": {
      "mode": "smart",
      "adaptiveMode": "suggest",
      "simpleTier": "balanced",
      "mediumTier": "strong",
      "hardTier": "max",
      "mediumThreshold": 4,
      "hardThreshold": 7
    }
  }
}
```

飞书命令：`/runtime cursor` | `/runtime kiro` | `/runtime gemini`

完整生产实践：[`runtime-routing-production.md`](./runtime-routing-production.md)  
示例配置：[`runtime-config.example.json`](./runtime-config.example.json)

## lwa-conduit CLI

```bash
lwa-conduit run --workspace ./my-ws --runtime-kind kiro-cli-acp
lwa-conduit run --workspace ./my-ws --runtime-kind cursor-agent-cli --kiro-cli agent
lwa-conduit run --workspace ./my-ws --runtime-kind gemini-cli
lwa-conduit report --base-repo .
lwa-conduit report --quota-only
```

环境变量（配额）：

- `LWA_CONDUIT_QUOTA_OVERRIDES` — JSON `{"cursor-agent-cli":"depleted"}`
- `LWA_CONDUIT_KIRO_MONTHLY_LIMIT` / `CURSOR` / `GEMINI` — 本地月度计数上限

生产建议：同一 DAG run 内同一角色保持 homogeneous runtime（不要混用两种 CLI）。

## 路由与观测

- 先做 CLI 路由：简单任务优先 `cursor-agent-cli`，复杂任务优先 `kiro-cli-acp`
- 配额硬约束：`depleted` / `error` 的 runtime 不参与路由；按 bucket fallback
- 原生探测（best-effort）：`kiro-cli usage --json`、`gemini quota --json`
- 命中 `kiro-cli` 后再做模型路由：从实时 `--list-models` 结果里选模型
- 任务分桶：bridge 记 `taskBucket`（chat/review/plan/edit/conduit）；conduit 按角色（planner/implementor/reviewer）
- 自适应：`off` / `suggest` / `apply-safe` / `apply-aggressive`，按桶、多目标分数（成功率+耗时+改动+成本）
- reviewer：`execution_ok` 与 `verdict_pass` 分开；审查 FAIL 不算 runtime 失败
- `lark-kiro-bridge` Dashboard 展示按桶 metrics / score / adaptive 推荐 / **quota status**（60s 重探）
- `lwa-conduit report` 打印分桶 metrics、avg_duration、score、推荐、**quota**

## 演进

- 季度路线图（第三 runtime、Ingress 抽象、配额 fallback）：[`ROADMAP-LWA.md`](./ROADMAP-LWA.md)
- Ingress 抽象（Q4）：[`spikes/ingress-abstraction.md`](./spikes/ingress-abstraction.md)
- 配额探测设计草案：[`spikes/quota-probe.md`](./spikes/quota-probe.md)

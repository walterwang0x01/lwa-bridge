# Agent Runtime 规范

多 CLI 兼容层的跨项目约定（`lark-kiro-bridge` TypeScript + `kiro-conduit` Python）。

## Runtime kinds

| kind | binary | 协议 |
|------|--------|------|
| `kiro-cli-acp` | `kiro-cli` | ACP JSON-RPC over stdio |
| `cursor-agent-cli` | `agent` | NDJSON `stream-json` via `--print` |

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
      "cursor": { "kind": "cursor-agent-cli", "bin": "agent", "force": true, "model": "Auto" }
    },
    "router": {
      "mode": "smart",
      "lark": { "simpleProfile": "cursor", "complexProfile": "kiro" }
    }
  },
  "modelRouting": {
    "kiro": {
      "mode": "smart",
      "mediumThreshold": 4,
      "hardThreshold": 7
    }
  }
}
```

飞书命令：`/runtime cursor` | `/runtime kiro`

## kiro-conduit CLI

```bash
kiro-conduit run --workspace ./my-ws --runtime-kind kiro-cli-acp
kiro-conduit run --workspace ./my-ws --runtime-kind cursor-agent-cli --kiro-cli agent
```

生产建议：同一 DAG run 内保持 homogeneous runtime（不要混用两种 CLI）。

## 路由与观测

- 先做 CLI 路由：简单任务优先 `cursor-agent-cli`，复杂任务优先 `kiro-cli-acp`
- 命中 `kiro-cli` 后再做模型路由：从 `kiro-cli chat --list-models --format json` 的实时结果里选模型
- `lark-kiro-bridge` 会记录 `runtimeKind`、`model`、`complexityScore`、`modelRouteTier`
- `kiro-conduit` 会记录各角色的 runtime/model 选择，方便排查成本与稳定性问题

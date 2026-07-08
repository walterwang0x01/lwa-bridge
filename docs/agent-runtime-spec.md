# Agent Runtime 规范

多 CLI 兼容层的跨项目约定（`lark-kiro-bridge` TypeScript + `kiro-conduit` Python）。

## Runtime kinds

| kind | binary | 协议 |
|------|--------|------|
| `kiro-acp` | `kiro-cli` | ACP JSON-RPC over stdio |
| `cursor-cli` | `agent` | NDJSON `stream-json` via `--print` |

## Session ID

存储格式：`{kind}:{nativeId}`，例如 `cursor-cli:16255d95-...`。

切换 runtime 后不跨引擎续接 session。

## lark-kiro-bridge 配置

```json
{
  "runtime": {
    "default": "kiro",
    "profiles": {
      "kiro": { "kind": "kiro-acp", "bin": "kiro-cli" },
      "cursor": { "kind": "cursor-cli", "bin": "agent", "force": true }
    }
  }
}
```

飞书命令：`/runtime cursor` | `/runtime kiro`

## kiro-conduit CLI

```bash
kiro-conduit run --workspace ./my-ws --runtime-kind kiro-acp
kiro-conduit run --workspace ./my-ws --runtime-kind cursor-cli --kiro-cli agent
```

生产建议：同一 DAG run 内保持 homogeneous runtime（不要混用两种 CLI）。

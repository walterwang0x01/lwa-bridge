# Spike：Slack Ingress 骨架

> 状态：**骨架已注册（2026-07）** — Socket Mode 入站与 Block Kit 出站待 Q1 2027 实现。

## 配置（预留）

```json
{
  "ingress": {
    "channel": "lark",
    "slack": {
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "signingSecret": "..."
    }
  }
}
```

生产环境请保持 `"channel": "lark"`，直到 Slack 适配器完成。

## 代码位置

| 文件 | 说明 |
|------|------|
| `src/ingress/slack/port.ts` | 出站占位（抛错指引） |
| `src/ingress/slack/channel.ts` | `IngressChannel` 注册用 |
| `src/core/bootstrap.ts` | 启动时 `registerIngressChannel(slack)` |

## 实现清单（Q1）

1. Socket Mode 客户端（`@slack/bolt` 或原生 WebSocket）
2. 事件 → `NormalizedMessage` 映射（thread_ts、channel id）
3. Block Kit ↔ 现有卡片 schema 的最小映射层
4. 与 `dispatcher.handleNormalized` 端到端测试

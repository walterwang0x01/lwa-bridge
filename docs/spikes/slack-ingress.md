# Spike：Slack Ingress（Socket Mode）

> 状态：**已实装（2026-07）** — Socket Mode 入站、Block Kit 出站映射、`ingress.channel=slack` 可切换。

## 配置

```json
{
  "ingress": {
    "channel": "slack",
    "slack": {
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "signingSecret": "..."
    }
  },
  "lark": {
    "appId": "placeholder",
    "appSecret": "placeholder"
  }
}
```

Slack 模式下仍需 `lark` 配置项（schema 兼容）；凭证可填占位，主事件循环走 Slack。

### Slack App 准备

1. [api.slack.com](https://api.slack.com/apps) 创建 App
2. **Socket Mode** 开启，生成 `xapp-` App-Level Token（`connections:write`）
3. **OAuth** 安装到 workspace，复制 `xoxb-` Bot Token
4. Bot Token Scopes：`app_mentions:read`, `chat:write`, `im:history`, `channels:history`, `groups:history`
5. 订阅事件：`message.im`, `app_mention`（Socket Mode 下在 App 配置里启用）

## 代码位置

| 文件 | 说明 |
|------|------|
| `src/ingress/slack/channel.ts` | Bolt Socket Mode + 事件接线 |
| `src/ingress/slack/port.ts` | 出站：postMessage / chat.update / delete |
| `src/ingress/slack/normalize.ts` | Slack 事件 → `NormalizedMessage` |
| `src/ingress/slack/blocks.ts` | 飞书卡片 JSON → Block Kit（尽力映射） |
| `src/core/bootstrap.ts` | `ingress.channel` 选择 lark / slack |

## 限制（已知）

- 飞书 `column_set` / 复杂折叠面板会降级为 markdown
- 媒体下载 / ASR 暂未实现（返回空 / unsupported）
- `replyCard` 需要已知 message ts 所在 channel（由 port 内部 map 维护）

## 验收

- [x] `ingress.channel=slack` + token 时走 Socket Mode
- [x] 文本消息 → `dispatcher.handleNormalized`
- [x] 卡片 patch 经 `chat.update`
- [x] 按钮 `block_actions` → `handleNormalizedCardAction`
- [ ] 生产 dogfood：真实 workspace 端到端

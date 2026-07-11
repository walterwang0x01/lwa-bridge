# 迁移到 `lwa` CLI 与 `~/.lwa` 数据目录

## 变更摘要

| 项目 | 新 | 旧（仍兼容） |
|------|-----|-------------|
| **主 CLI 命令** | `lwa`（TTY 默认进纯净 REPL） | `lwa-bridge`、`lark-kiro-bridge` |
| **Gateway** | `lwa serve`（`lwa run` 别名） | `lark-kiro-bridge run` |
| **数据目录** | `~/.lwa/` | `~/.lark-kiro-bridge/`（首次启动自动迁移） |
| **npm 安装** | `npm i -g lark-kiro-bridge`（包名暂不变） | — |
| **macOS 守护** | `ai.lwa.bot` | `ai.lark-kiro-bridge.bot` |
| **Linux systemd** | `lwa.service` | `lark-kiro-bridge.service` |
| **Windows 任务** | `LWA.Bot` | `LarkKiroBridge.Bot` |

## 两条路径（生产实践）

```bash
# A. 本地纯净 REPL（不连飞书、不启 Dashboard、无卡片 UI）
lwa
# 或
lwa chat

# B. Gateway：按 config 连接飞书等通道 + Dashboard
lwa serve
```

`~/.lwa/config.json` 通道开关：

```json
{
  "ingress": {
    "channels": ["lark"]
  }
}
```

- `["lark"]` — 只连飞书（默认）
- `["lark","slack"]` — 多通道（Slack 需 token）
- `["lark","cli"]` — 飞书 + 本机 stdin（少用；守护进程一般不要挂 CLI）
- 本地 `lwa` / `lwa chat` **永远**不读飞书 WS，即使 channels 含 lark

## 升级步骤

```bash
npm i -g lark-kiro-bridge@latest

lwa              # 本地 REPL
lwa serve        # 飞书 Gateway
lwa serve --chat # Gateway + 本机 REPL（前台）
```

首次运行时会自动把 `~/.lark-kiro-bridge` **重命名**为 `~/.lwa`（若 `~/.lwa` 尚不存在）。

若两个目录都已存在，bridge **优先使用 `~/.lwa`**，并在控制台提示你手动合并或删除 legacy 目录。

## 守护进程

建议重新安装服务以更新 plist/unit 中的可执行路径：

```bash
lwa unregister   # 或 lwa service uninstall
lwa start
```

`stop` / `uninstall` 会同时尝试卸载新旧服务名。守护进程执行的是 `lwa serve`。

## 常用命令对照

| 旧 | 新 |
|----|-----|
| `lark-kiro-bridge run` | `lwa serve`（或 `lwa run`） |
| `lark-kiro-bridge chat` | `lwa` / `lwa chat` |
| `lark-kiro-bridge models` | `lwa models` |
| `lark-kiro-bridge init` | `lwa init` |
| `lark-kiro-bridge start` | `lwa start` |

# 迁移到 `lwa` CLI 与 `~/.lwa` 数据目录

## 变更摘要

| 项目 | 新 | 旧（仍兼容） |
|------|-----|-------------|
| **主 CLI 命令** | `lwa` | `lwa-bridge`、`lark-kiro-bridge` |
| **数据目录** | `~/.lwa/` | `~/.lark-kiro-bridge/`（首次启动自动迁移） |
| **npm 安装** | `npm i -g lark-kiro-bridge`（包名暂不变） | — |
| **macOS 守护** | `ai.lwa.bot` | `ai.lark-kiro-bridge.bot` |
| **Linux systemd** | `lwa.service` | `lark-kiro-bridge.service` |
| **Windows 任务** | `LWA.Bot` | `LarkKiroBridge.Bot` |

## 升级步骤

```bash
npm i -g lark-kiro-bridge@latest

# 前台
lwa run

# 或纯终端
lwa chat

# 飞书 + 终端并行
lwa run --chat
```

首次运行时会自动把 `~/.lark-kiro-bridge` **重命名**为 `~/.lwa`（若 `~/.lwa` 尚不存在）。

若两个目录都已存在，bridge **优先使用 `~/.lwa`**，并在控制台提示你手动合并或删除 legacy 目录。

## 守护进程

建议重新安装服务以更新 plist/unit 中的可执行路径：

```bash
lwa unregister   # 或 lwa service uninstall
lwa start
```

`stop` / `uninstall` 会同时尝试卸载新旧服务名。

## 常用命令对照

| 旧 | 新 |
|----|-----|
| `lark-kiro-bridge run` | `lwa run` |
| `lark-kiro-bridge chat` | `lwa chat` |
| `lark-kiro-bridge models` | `lwa models` |
| `lark-kiro-bridge init` | `lwa init` |
| `lark-kiro-bridge start` | `lwa start` |

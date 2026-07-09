# Bridge（lark-kiro-bridge）

> **Lark Local Agent Workbench（LWA）** 的飞书入口 — 在本机项目上跑多 CLI Agent（Cursor / Kiro），带智能路由与可观测性。
>
> 把 **本地 Agent CLI** 接到飞书 / Lark — 在飞书里聊代码、跑命令、操作飞书自己。简单任务走 Cursor Auto，复杂任务自动升级 Kiro。

[![npm version](https://img.shields.io/npm/v/lark-kiro-bridge.svg?color=cb3837)](https://www.npmjs.com/package/lark-kiro-bridge)
[![npm downloads](https://img.shields.io/npm/dm/lark-kiro-bridge.svg)](https://www.npmjs.com/package/lark-kiro-bridge)
[![license](https://img.shields.io/npm/l/lark-kiro-bridge.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/lark-kiro-bridge.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/walterwang0x01/lark-kiro-bridge?style=social)](https://github.com/walterwang0x01/lwa-bridge)

🇨🇳 中文 | [🇺🇸 English](./README.en.md)

---

群里 `@bot` 或私聊机器人，消息经 **ACP（Agent Client Protocol）** 对接本地 `kiro-cli acp`，回复以**结构化卡片 + 流式打字光标**实时刷新。每个 chat 独立 session，切目录不丢上下文。

**核心价值**：云端 AI 编程助手（Cursor / Copilot / Devin）碰不到你本机的项目目录，也没有飞书 API 调度能力。Bridge **=** 在飞书里跑本地命令 **+** 操作飞书自己，一个机器人解决两件事。

**LWA 体系**：Bridge 负责飞书对话与轻量任务；长任务与并行编排交给 [Conduit（kiro-conduit）](https://github.com/walterwang0x01/lwa-conduit)。详见 [docs/SYSTEM_OVERVIEW.md](./docs/SYSTEM_OVERVIEW.md)。

```
┌───────────────────────────────────────┐
│ 💬 Kiro                                │
├───────────────────────────────────────┤
│ ☕ 3 个工具调用 ▸ (folded)             │
│ ✅ Bash — lark-cli calendar +create…▾ │  ← 最新工具实时展开
│ ┌─────────────────────────────────┐   │
│ │ **Command** lark-cli calendar … │   │
│ │ **Output** {"ok": true, ...}    │   │
│ └─────────────────────────────────┘   │
│                                        │
│ 日程已创建成功 ✅                      │
│ 主题：测试                             │
│ 时间：今天 23:00 ~ 明天 00:00          │
│                                        │
│ ✍️ 正在输出     [ ⏹ 终止 ]            │
└───────────────────────────────────────┘
```

## 目录

<details>
<summary>展开</summary>

- [✨ 特性](#-特性)
- [🚀 快速上手](#-快速上手)
- [📖 飞书内的命令](#-飞书内的命令)
- [💡 使用场景](#-使用场景)
- [⚙️ 配置](#️-配置)
- [📚 进阶文档](#-进阶文档)
- [🤝 参与贡献](#-参与贡献)
- [📄 License](#-license)

</details>

## ✨ 特性

- 🎴 **结构化卡片** — 基于 ACP 结构化事件渲染：每次工具调用独立可折叠面板，显示 Kiro 提供的真实标题、按类型区分图标、展示工具执行结果，多调用自动聚合，思考过程独立展示
- ⚡ **流式打字光标** — 飞书原生 `streaming_mode`，配合 footer 实时状态指示
- 🗂️ **工作区方案 B** — 切目录不丢上下文：每个 `(chat, cwd)` 独立 Kiro session，自动续聊
- 🔘 **按钮可点** — `/model` `/help` `/status` `/ws list` `/config` 全部可点击操作，0 命令记忆
- 📝 **`/config` 飞书内表单** — 在飞书里改访问控制和偏好，即时生效，防自锁校验
- 🚄 **rapid-fire 消息合并** — 200ms 内连发的多条短消息自动合并为一次 Kiro 调用，不再被前一条 abort
- ⏰ **`/cron` 定时任务** — 标准 cron / shorthand / 中文关键词都接受；不识别时让 Kiro 自己翻译，二次确认后创建。"每天 9 点总结昨天的 commits" 一句话搞定
- 📅 **`/schedule new` 可视化定时表单** — 不会写 cron 表达式的同学（HR / 销售 / 行政等）直接填表：小时、分钟、内容三个框搞定。底层和 `/cron` 共享存储
- 🧠 **`/steering` 飞书内管理 Kiro 指令文件** — list/view/edit/new/rm，全局或项目 scope，飞书表单直接改，永久生效
- 🎤 **语音输入** — 飞书发语音消息 → 自动转写（飞书 ASR）→ 喂给 Kiro，需 `ffmpeg` 和 ASR 权限
- 🛡️ **优雅终止** — 中止/超时先发 ACP `session/cancel`，2 秒后兜底 `SIGTERM→SIGKILL` 强杀子进程
- ⏱ **Idle Watchdog** — 卡住自动 killTree，可全局 / per-chat 配置
- 🔐 **三层访问控制** — 用户 / 群 / 管理员白名单，**DM 永远豁免群白名单**，不会把自己锁外面
- 🐧 **跨平台守护** — macOS launchd / Linux systemd --user / Windows Task Scheduler，崩溃自动拉起，开机自启
- 🖥️ **`/ps` `/exit` 进程管理** — 飞书内列出本机所有 bridge 进程，按按钮停止
- 📊 **`/doctor` 自诊断** — 让 Kiro 看日志自己分析故障
- 🖥️ **Web Dashboard** — 本机 `http://127.0.0.1:5180` 只读控制台（会话/定时任务/进程/技能/日志），Vue 3 构建，浏览器打开即用，可配合 Tailscale 手机访问
- 🚦 **`/conduit`** — 串联 [kiro-conduit](https://github.com/walterwang0x01/lwa-conduit) 多 agent 并行编排器，飞书里一句话跑大 spec（plan 拆分 / run 执行 / --merge 二次确认）

## 🚀 快速上手

### 前置条件

- macOS / Linux / Windows
- Node.js ≥ 20
- `kiro-cli` 已安装并登录
- 飞书账号（个人版即可，扫码自动创建应用）
- **可选**：`ffmpeg`（用于语音输入转写，`brew install ffmpeg` / `apt install ffmpeg`）+ 飞书 ASR scope `speech_to_text:speech`（飞书免费版租户不支持）

### 30 秒上线 ⚡

```bash
# 1. 安装
npm i -g lark-kiro-bridge

# 2. 启动（首次会自动弹二维码 → 扫码同意 → 完成）
lark-kiro-bridge run
```

> **就这么简单**——飞书 App 扫码同意后，bridge 自动创建应用、配好凭证、开通必要权限。

启动后在飞书私聊机器人发「你好」，应该立即看到流式刷新的卡片。

### 想用已有的飞书应用？

如果你已经在飞书开放平台手动建过应用，想复用已有的 App ID/Secret：

```bash
lark-kiro-bridge init --manual
# 交互式输入 App ID 和 App Secret
```

或一行搞定：

```bash
lark-kiro-bridge init --app-id cli_xxx --app-secret xxx
```

> 飞书后台手动配置（订阅事件 `im.message.receive_v1` + `card.action.trigger`）→ [docs/FAQ.md](./docs/FAQ.md)

### 后台守护（推荐生产）

```bash
lark-kiro-bridge start          # 装平台原生服务并启动
lark-kiro-bridge status         # 看状态
lark-kiro-bridge restart        # 重启
```

平台映射：

| 平台 | 实现 | 服务定义路径 |
|---|---|---|
| **macOS** | launchd 用户代理 | `~/Library/LaunchAgents/ai.lark-kiro-bridge.bot.plist` |
| **Linux** | systemd 用户单元 | `~/.config/systemd/user/lark-kiro-bridge.service` |
| **Windows** | Task Scheduler ONLOGON | 任务名 `LarkKiroBridge.Bot`，启动器 `~/.lark-kiro-bridge/daemon-launcher.cmd` |

> Linux 想让 daemon 在用户登出后还跑（比如服务器场景），跑一次：
> `loginctl enable-linger $USER`

### 📊 Web Dashboard

bridge 跑起来后自动在本机起一个只读控制台，浏览器直接打开：

```
http://127.0.0.1:5180
```

看得到：当前所有飞书 chat 的会话状态、定时任务列表、本机 bridge 进程、`~/.kiro/skills` 技能清单、最近日志（5 秒自动刷新）。纯只读，不暴露任何写操作。

默认开启，端口可在 `config.json` 的 `dashboard.port` 改；`dashboard.enabled: false` 可关闭。

**手机访问**（比如用 Telegram 那种远程盘一样看状态）：

```bash
tailscale serve 5180
```

装了 [Tailscale](https://tailscale.com/) 后用它给的地址在手机浏览器打开即可，仍然只在你自己的设备间可见。

## 📖 飞书内的命令

### 日常命令（所有人）

| 命令 | 别名 | 作用 |
|---|---|---|
| `/help` | `/h` `/?` | 帮助卡片（可点按钮） |
| `/status` | `/s` | 当前 cwd / session / watchdog |
| `/model [name]` | `/m` | 查看 / 切换模型，按钮一键切 |
| `/new` | `/reset` | 重置当前 cwd 下的 Kiro 会话 |
| `/stop` | `/abort` | 停止正在跑的任务 |
| `/pwd` | `/cwd` | 当前工作目录 |
| `/ws list` | — | 列出命名工作区，按钮一键切 |
| `/timeout [N\|off]` | `/to` | idle watchdog 阈值（分钟） |
| `/ps` | — | 列出本机所有 bridge 进程 |
| `/steering` | `/memory` `/mem` | 列出当前项目的 Kiro 指令文件（卡片+按钮） |
| `/cron` | `/schedule` | 列出当前 chat 的定时任务（卡片+按钮） |
| `/skill` | — | 列出全局 Skill（`~/.kiro/skills`） |
| `/agent` | — | 列出可用角色（`~/.kiro/agents`）+ 当前生效 |
| `/doctor [描述]` | — | 让 Kiro 看日志自诊断 |

### 管理员命令

| 命令 | 作用 |
|---|---|
| `/config` | 查看 / 编辑访问控制 + 偏好（飞书内表单，即时生效） |
| `/cd <path>` | 切换工作目录（受 `allowedRoots` 限制） |
| `/ws save <name>` | 把当前 cwd 存为命名工作区 |
| `/ws use <name>` | 切到命名工作区 |
| `/ws remove <name>` | 删除命名工作区 |
| `/steering edit/new/rm <name>` | 编辑 / 新建 / 删除 steering 文件 |
| `/cron add <expr> <prompt>` | 添加定时任务；expr 接受 cron / `@daily` / `每天9点` 等 |
| `/cron rm/pause/resume/run <id>` | 删除/暂停/恢复/手动跑指定任务 |
| `/schedule new` | 弹一张表单卡片，0 cron 表达式建任务（小白入口；当前覆盖「每天 H:M」频率） |
| `/exit <id\|#>` | 停止指定 bridge 进程（自己 / 他人） |
| `/reconnect` | 强制重连飞书 WebSocket |
| `/conduit run [--merge]` | 跑 [kiro-conduit](https://github.com/walterwang0x01/lwa-conduit)（当前目录需有 `dag.yaml`）；`--merge` 弹二次确认卡片 |
| `/conduit plan <spec.md>` | 让 Kiro 把 markdown spec 拆成 `dag.yaml` 工作区 |
| `/skill source add <name> <git-url>` | 注册一个 Skill 来源（Git 仓库） |
| `/skill sync <name>` | clone/pull 来源，列出可安装的 Skill（含供应链风险提示） |
| `/skill install <name> <skill>` | 安装某个 Skill 到 `~/.kiro/skills`（不覆盖已存在） |
| `/agent <name>` | 切换当前会话的角色（Agent_Config，下一条消息生效） |
| `/agent create <name>` | 创建一个角色配置模板到 `~/.kiro/agents` |
| `/agent reset` | 清除角色覆盖，回归 Kiro 默认 |
| `/agent install-defaults` | 安装内置默认角色库（客服问答 / 代码审查） |
| `/agent sync <source>` | 从 Git 来源同步团队自定义角色（含供应链风险提示） |

> 默认所有人都是管理员（`access.admins` 为空）。团队推广前请收紧。

**响应规则**：私聊全收；群里必须 `@bot`；`@all` 永不响应。

## 💡 使用场景

```
你: 删掉今天 23 点的会议
🤖 调 lark-cli calendar +agenda 找到日程 → 二次确认 → +delete

你: 整理一下上周的会议纪要发到产品群
🤖 lark-cli vc +list → 提取纪要 → 调 lark-cli message +send 到指定群

你: 把 portfolio 项目今天的改动 commit 一下
🤖 cd portfolio → git diff → 拆分 atomic commits → git push

你: 查一下张三的 open_id 顺便给他发个会议邀请
🤖 lark-cli contact +find 张三 → 拿到 open_id → 调 lark-cli calendar +create

你: [发了一张设计稿] 帮我评估技术可行性
🤖 自动下载图片 → @file 喂给 Kiro → 视觉分析 + 给出实现方案
```

## ⚙️ 配置

### 最小可用（自动生成）

`lark-kiro-bridge init` 写入 `~/.lark-kiro-bridge/config.json`：

```json
{
  "lark": {
    "appId": "cli_xxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxx"
  }
}
```

其他字段都有合理默认值。

### 完整配置参考

<details>
<summary>点开看所有可配置项</summary>

```json
{
  "lark": {
    "appId": "cli_xxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxx"
  },
  "kiro": {
    "binPath": "kiro-cli",
    "trustedTools": [
      "fs_read", "fs_write", "grep", "glob", "code",
      "execute_bash", "web_search", "web_fetch"
    ],
    "timeoutMs": 600000,
    "idleTimeoutMinutes": 5,
    "model": "claude-sonnet-4.6"
  },
  "workspace": {
    "defaultCwd": "/Users/you/Projects",
    "allowedRoots": ["/Users/you/Projects"]
  },
  "access": {
    "allowedUsers": [],
    "allowedChats": [],
    "admins": []
  },
  "preferences": {
    "requireMentionInGroup": true,
    "cardUpdateIntervalMs": 800,
    "logRetentionDays": 7
  }
}
```

`trustedTools` — Kiro 不询问就能调用的工具：
- `fs_read fs_write grep glob code` — 文件读写、代码搜索
- `execute_bash` — 跑 shell 命令（lark-cli / git / 等）。**单人用安全；团队场景请评估**
- `web_search web_fetch` — 联网搜资料

`access` — 三层白名单，详见 [SECURITY.md](./SECURITY.md)：
- `allowedUsers` 为空 = 所有人允许
- `allowedChats` 为空 = 所有 chat 允许
- `admins` 为空 = 所有人都是管理员

`workspace.allowedRoots` — `/cd` 能去的根目录白名单，限制爆炸半径。

</details>

### CLI

```bash
lark-kiro-bridge init                # 扫码创建飞书应用（首选）
lark-kiro-bridge init --manual       # 手动输入已有 App ID/Secret
lark-kiro-bridge init --app-id <id> --app-secret <s>   # 一行搞定（CI 友好）
lark-kiro-bridge run                 # 前台启动（首次自动跳扫码）
lark-kiro-bridge config-show         # 显示当前配置（脱敏）

lark-kiro-bridge start               # 装并起 daemon
lark-kiro-bridge stop                # 停 daemon
lark-kiro-bridge restart             # 重启
lark-kiro-bridge status              # 状态
lark-kiro-bridge unregister          # 卸载

lark-kiro-bridge ps                  # 列本机所有 bridge 进程
lark-kiro-bridge kill <id> [--force] # 杀掉某个进程
```

## 📚 进阶文档

| 文档 | 内容 |
|---|---|
| [docs/ROADMAP-LWA.md](./docs/ROADMAP-LWA.md) | **LWA 跨项目季度路线图**（Ingress / Gemini / 配额 / v1.0） |
| [docs/REPO_RENAME_PLAN.md](./docs/REPO_RENAME_PLAN.md) | 阶段 B 迁移规划（B3 GitHub 已完成） |
| [docs/PITCH.md](./docs/PITCH.md) | **对外介绍**：30 秒 pitch、适合谁、一句话可复制 |
| [docs/SYSTEM_OVERVIEW.md](./docs/SYSTEM_OVERVIEW.md) | **LWA 体系总览**：Bridge + Conduit 分工、多 CLI 策略、分桶自适应 |
| [docs/runtime-routing-production.md](./docs/runtime-routing-production.md) | 生产级 runtime 路由、adaptive 模式与 Dashboard 指标 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 整体数据流、卡片渲染体系、工作目录方案 B、设计取舍 |
| [docs/FAQ.md](./docs/FAQ.md) | 常见疑问 + 故障排查（机器人不响应 / 200340 / 卡片卡死 / …） |
| [SECURITY.md](./SECURITY.md) | 安全策略、漏洞披露、加固指南 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更日志 |

## 🤝 参与贡献

PR / Issue 都欢迎。开发流程：

```bash
git clone https://github.com/walterwang0x01/lwa-bridge.git
cd lark-kiro-bridge
pnpm install                                # pnpm workspace，会顺带装 dashboard-ui 依赖
pnpm typecheck && pnpm lint && pnpm test    # 提交前必跑
pnpm build                                  # 先构建 dashboard-ui 再 tsup 主包
node bin/lark-kiro-bridge.mjs run           # 本地跑（先 stop daemon）
```

代码规范：TypeScript strict / Biome lint / vitest 测试 / commit 用 conventional commits。`dashboard-ui/`（Web Dashboard 前端）是独立的 Vue 3 + Vite 子项目，`.vue` 文件的类型检查走 `vue-tsc`（`pnpm typecheck` 里已级联），biome 只覆盖它的 `.ts` 文件。

## 路线图

- **v0.2** ✅ 当前版（结构化卡片 + 按钮回调 + Slack-style 工具面板 + 扫码绑定 + 语音输入 ASR）
- **v0.3** ✅ `/config` 飞书内表单 + 三层访问控制（DM 豁免群白名单）+ rapid-fire 消息合并
- **v0.4** ✅ Linux systemd / Windows Task Scheduler 守护 + `/ps` `/exit` 飞书内进程管理
- **v0.5** ✅ `/steering` 飞书内管理 Kiro 指令文件（list/view/edit/new/rm，global/project scope）
- **v0.6** ✅ `/cron` 定时任务（cron / shorthand / 中文关键词；不识别让 Kiro 翻译并二次确认）
- **v0.7** ✅ `/schedule new` 可视化表单（小白入口，0 cron 心智）+ `/selftest` 健康检查 + 修飞书 form 200530 隐藏 bug
- **v0.8** ✅ 引用回复 / 合并转发上下文还原 + 空任务卡片静默丢弃 + 任务计划卡片
- **v0.9** ✅ Kiro 集成迁移到 ACP（Agent Client Protocol）：JSON-RPC over stdio，结构化工具事件直驱卡片，不再解析 stdout
- **v0.10** ✅ 只读 Web Dashboard（Vue 3，会话/定时任务/进程/技能/日志）+ `/conduit` 串联 kiro-conduit 多 agent 并行编排
- **v1.0** 服务器集中部署 / 多用户隔离 / Dashboard 可操作（网页触发任务）

## 📄 License

[MIT](./LICENSE) © 2026 walterwang0x01

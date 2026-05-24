# lark-kiro-bridge

把本机的 **Kiro CLI** 接到飞书 / Lark 上：在群里 `@bot` 或私聊机器人，消息直达本地 `kiro-cli chat`，回复以**结构化卡片 + 流式打字光标**实时刷新；每个聊天独立 session，切目录不丢上下文。

不止是"飞书里聊代码"——结合 Kiro 自带的 lark-* 技能集，机器人还能反过来帮你**操作飞书自己**：删日程、查邮件、改文档、跑 Base 查询、生成 PPT。本地文件操作 + 飞书 API 编排，一个机器人都能干。

```
┌─────────────────────────────────────┐
│ 💬 Kiro                              │
├─────────────────────────────────────┤
│ ☕ 3 个工具调用 ▸  (folded)          │
│ ✅ Bash — lark-cli calendar +create…▾│  ← 最新工具实时展开
│ ┌─────────────────────────────────┐ │
│ │ **Command** lark-cli calendar … │ │
│ │ **Output**                      │ │
│ │ ```                             │ │
│ │ {"ok": true, ...}               │ │
│ │ ```                             │ │
│ └─────────────────────────────────┘ │
│                                      │
│ 日程已创建成功 ✅                    │
│ 主题：测试                           │
│ 时间：今天 23:00 ~ 明天 00:00        │
│                                      │
│ ✍️ 正在输出                          │
│ [ ⏹ 终止 ]                          │
└─────────────────────────────────────┘
```

## 它能做什么

### 核心交互

- **飞书消息 → Kiro CLI**：群里 `@bot` 或私聊机器人，消息被转发给本机 `kiro-cli chat`，回复实时刷新到飞书。
- **结构化卡片**：每次工具调用一个独立的可折叠面板（Read/Bash/Grep/WebFetch/…），多个调用聚合时自动收纳，思考过程独立 panel。错误时面板红色边框。
- **流式打字光标**：进行中卡片显示飞书原生打字光标 + footer 状态指示（🧠 思考中 / 🧰 调工具 / ✍️ 输出中），通知列表实时更新摘要。
- **每个 chat 独立 Kiro session**：不同群、不同工作目录互相隔离，续聊靠 `--resume-id` 自动接上。
- **打断与排队**：新消息到达自动 abort 旧任务；卡片底部 `⏹ 终止` 按钮、`/stop` 命令都能主动中止。
- **图片 / 文件输入**：发到机器人，自动下载到本地，把绝对路径喂给 Kiro 处理。
- **多模型切换**：`/model` 命令查看 / 切换 / 重置 kiro-cli 模型，按钮一键切。

### 命令型卡片（按钮回调）

- **`/model`** → 模型选择卡片，每行带「选用」蓝色按钮，主力 / 实验性 / 旧版分组折叠
- **`/help`** → 命令帮助卡片，底部「📊 状态 / 🎛️ 模型 / 🗂️ 工作区 / 🔄 重置会话」快捷按钮
- **`/status`** → 状态卡片，底部按钮直接跳转模型/工作区/重置/停止
- **`/ws list`** → 工作区列表，每行「切换」按钮

按钮回调走飞书 `card.action.trigger` 事件，需要在飞书开放平台「事件与回调 → 回调 → 已订阅的回调」里加上 `card.action.trigger`（卡片回传交互）。

### 工作区管理

- **工作目录方案 B**：`(chatId, cwd) → kiroSessionId` 双层映射，**切目录不丢上下文，切回来自动续聊**。
- **命名工作区**：`/ws save brand` 把当前 cwd 起个名字，下次 `/ws use brand` 一句切回。
- **根目录白名单**：`workspace.allowedRoots` 限制 `/cd` 能去的范围，避免误切到敏感目录。

### 运维与稳定性

- **进程注册表**：同一个飞书 app 多实例运行会被检测出来（避免 WS 事件被随机路由导致"机器人有时回复有时不回复"）。
- **进程组 kill**：spawn kiro-cli 时用 `detached: true` + `process.kill(-pid)`，避免子孙进程（kiro-cli → bun → acp）被打不死。
- **Idle watchdog**：kiro-cli 卡住时自动 killTree，可全局或按 chat 配置阈值。
- **结构化日志**：NDJSON 按天滚动，超期自动清理，`/doctor` 把日志反喂给 Kiro 自诊断。
- **访问控制**：用户白名单 / 群白名单 / 管理员白名单三层。
- **macOS 后台守护**：`launchd` plist，崩溃自动拉起，开机自启。

### 与 Kiro 生态的联动

这是本项目真正的护城河——配合 Kiro 自带的 lark-* 技能，机器人能用飞书 API 操作飞书自己：

- 在群里说"删掉今天 23 点的会议" → Kiro 调 lark-calendar 找到日程，确认后删除
- "整理一下上周的会议纪要" → Kiro 调 lark-vc 搜索会议，提取纪要，生成周报
- "把这个改动提交一下，拆成原子 commit" → Kiro 在你指定的项目目录执行 git workflow
- "查一下张三的 open_id" → Kiro 调 lark-contact 解析

这是云端 AI 编程助手（Cursor / Copilot / Devin）做不到的——它们碰不到你本机的项目目录，也没有飞书 API 调度能力。

## 快速上手

### 0. 前置条件

- macOS（Linux / Windows daemon 在路线图，前台 `run` 模式可用）
- Node.js ≥ 20
- `kiro-cli` 已装好且能跑：`kiro-cli chat --no-interactive --trust-all-tools "hi"` 应有输出
- 飞书企业自建应用，配置如下：
  - 开启**机器人能力**
  - 「事件与回调 → 事件配置」：订阅 `im.message.receive_v1`，订阅方式「使用长连接接收事件」
  - 「事件与回调 → 回调配置」：订阅 `card.action.trigger`（卡片回传交互），同样使用长连接
  - 「权限管理」：`im:message`（必须）、`im:resource`（图片下载）

### 1. 安装

```bash
git clone https://github.com/walterwang0x01/lark-kiro-bridge.git
cd lark-kiro-bridge
pnpm install
pnpm build
node bin/lark-kiro-bridge.mjs --help
```

或从 npm 全局安装（推荐部署）：

```bash
npm i -g lark-kiro-bridge
lark-kiro-bridge --help
```

### 2. 配置飞书凭证

```bash
lark-kiro-bridge init
# 提示输入 App ID 和 App Secret
# 写入 ~/.lark-kiro-bridge/config.json （权限 0600）
```

或者直接编辑 `~/.lark-kiro-bridge/config.json`：

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

`trustedTools` 决定 Kiro 不询问就能直接调用的工具：
- `fs_read fs_write grep glob code` — 文件读写、代码搜索
- `execute_bash` — 跑 shell 命令（lark-cli / git / 等）。**单人本机用安全；团队场景请评估**
- `web_search web_fetch` — 联网搜资料

### 3. 启动

前台跑（开发调试用）：

```bash
lark-kiro-bridge run
```

后台守护（推荐生产）：

```bash
lark-kiro-bridge start          # 等同于 service install + service start
lark-kiro-bridge status         # 看 daemon 状态
lark-kiro-bridge stop           # 停 daemon
lark-kiro-bridge restart        # 重启 daemon
```

启动成功后，在飞书私聊机器人发"你好"，应当看到一张流式刷新的卡片。

## 飞书内的斜杠命令

| 命令 | 别名 | 作用 | 谁能用 |
|------|------|------|------|
| `/help` | `/h` `/?` | 帮助卡片 | 所有人 |
| `/status` | `/s` `/stat` | 当前 cwd / 工作区 / Kiro session / 任务状态 | 所有人 |
| `/pwd` | `/cwd` | 当前工作目录 | 所有人 |
| `/new` | `/reset` `/clear` | 重置当前 cwd 下的 Kiro 会话 | 所有人 |
| `/stop` | `/abort` `/cancel` | 停止正在跑的 Kiro 任务 | 所有人 |
| `/model [name\|auto]` | `/m` `/mod` `/models` | 查看 / 切换 / 重置模型；带短名容错（`/m sonnet-4.6` 自动补 `claude-`） | 所有人 |
| `/timeout [N\|off\|default]` | `/to` | 设置 idle watchdog 阈值（分钟） | 所有人 |
| `/doctor [描述]` | — | 把日志反喂给 Kiro 自诊断 | 所有人 |
| `/ws list` | — | 列出所有命名工作区 | 所有人 |
| `/cd <path>` | — | 切换工作目录（支持 `~/` 展开，受 `allowedRoots` 限制） | **管理员** |
| `/ws save <name>` | — | 把当前 cwd 存为命名工作区 | **管理员** |
| `/ws use <name>` | — | 切到命名工作区 | **管理员** |
| `/ws remove <name>` | — | 删除命名工作区 | **管理员** |
| `/reconnect` | `/rc` | 强制重连飞书 WebSocket | **管理员** |
| 其他 `/xxx` | — | 原样转发给 Kiro CLI | 所有人 |
| 任意文本 | — | 转发给 Kiro CLI | 所有人 |

**响应规则**：
- 私聊：所有消息都触发
- 群聊（含主题群）：必须 `@bot` 才触发；`requireMentionInGroup: false` 可关闭这个限制
- `@all` 永不响应

⚠️ kiro-cli 自带的 TUI 命令（`/agent` `/tools` `/compact` `/login` `/logout` `/session` 等）在非交互模式下不可用，桥接器会拦截并提示「请用 `/help` 查看可用命令」。

## 卡片设计

参考自 zara/feishu-claude-code-bridge + Slack Thinking Steps 设计：

- **每次工具调用 = 一个 collapsible_panel**：header 显示 `✅ Read — ~/path/to/file.md`，点开看 input/output
- **多个工具自动聚合**：≥3 个时前面折叠成「☕ N 个工具调用」总结，最新一个完整展示（进行中状态）
- **思考过程独立 panel**：进行中默认展开，结束自动折叠
- **streaming_mode**：进行中卡片配置 `streaming_mode: true`，飞书显示打字光标
- **summary 字段**：通知列表显示「正在调用工具 / 正在输出」实时状态
- **安全大小限制**：单工具 body 最多 2.5KB（防止超 30KB 单 element 限制），超出截断到 `/doctor`/日志查全文
- **错误工具红边框**：status === 'error' 的 panel 用红色 border

源码：`src/card/runRenderer.ts` `src/card/toolRender.ts` `src/kiro/runStreamParser.ts`

## 工作目录方案 B 是怎么工作的

每个飞书 chat 维护一个状态对象：

```json
{
  "currentCwd": "/Users/.../portfolio",
  "sessionsByCwd": {
    "/Users/.../portfolio": "kiro-sess-aaa",
    "/Users/.../agenzo":    "kiro-sess-bbb"
  },
  "idleTimeoutMinutes": null
}
```

也就是说：

1. **切目录不丢上下文** — 你 `/cd ~/Projects/agenzo` 之后，portfolio 那条 Kiro session 还在；切回去自动续聊。
2. **每个 (chat, cwd) 独立 session** — 不同群、不同目录之间不会串话。
3. **命名工作区**只是绝对路径的别名 — `/ws save brand → /Users/.../personal-brand-agent` 之后 `/ws use brand` 等同于 `/cd /Users/.../personal-brand-agent`。
4. **per-chat watchdog 覆盖** — `/timeout 10` 只影响当前 chat，不影响其他 chat 和全局默认。

## 数据目录

| 路径 | 内容 |
|------|------|
| `~/.lark-kiro-bridge/config.json` | 凭证 + 配置（mode 0600） |
| `~/.lark-kiro-bridge/sessions.json` | 每个 chat 的 cwd + (cwd → kiroSessionId) + per-chat watchdog 覆盖 |
| `~/.lark-kiro-bridge/workspaces.json` | 命名工作区映射 |
| `~/.lark-kiro-bridge/processes.json` | 当前运行的 bridge 实例注册表（启动时检测同 app 多实例） |
| `~/.lark-kiro-bridge/media/<chatId>/` | 飞书发来的图片 / 文件，24h 后自动清理 |
| `~/.lark-kiro-bridge/logs/YYYY-MM-DD.log` | NDJSON 结构化日志，超过 `logRetentionDays`（默认 7 天）启动时清理 |
| `~/.lark-kiro-bridge/logs/daemon-{stdout,stderr}.log` | launchd 输出 |

## 访问控制（团队推广用）

默认全开（`allowedUsers/allowedChats/admins` 都为空）。一个人用足够，团队推广前先收紧：

```json
"access": {
  "allowedUsers": ["ou_xxxxxxxxxxxxx"],
  "allowedChats": ["oc_xxxxxxxxxxxxx"],
  "admins":       ["ou_xxxxxxxxxxxxx"]
}
```

- **allowedUsers** 为空 = 所有用户允许；非空 = 仅列出的允许
- **allowedChats** 同理；DMs 不受群白名单约束
- **admins** 为空 = 所有用户都是管理员；非空 = 仅列出的能跑 `/cd` `/ws save/use/remove` `/reconnect`

找 `open_id` / `chat_id` 最快的办法：让目标用户私聊一句机器人，然后看日志：

```bash
grep '"chatId"' ~/.lark-kiro-bridge/logs/$(date +%Y-%m-%d).log | tail -3
```

## CLI 命令

```
lark-kiro-bridge init                # 首次配置（写凭证）
lark-kiro-bridge run                 # 前台启动
lark-kiro-bridge config-show         # 显示当前配置（敏感字段脱敏）

lark-kiro-bridge start               # 安装并启动 launchd daemon
lark-kiro-bridge stop                # 停 daemon
lark-kiro-bridge restart             # 重启
lark-kiro-bridge status              # daemon 状态
lark-kiro-bridge unregister          # 卸载 plist

lark-kiro-bridge ps                  # 列本机所有 bridge 进程
lark-kiro-bridge kill <pid|shortId>  # 杀掉某个进程
lark-kiro-bridge kill <id> --force   # SIGKILL 兜底

lark-kiro-bridge service install     # = start 第一步（仅装 plist）
lark-kiro-bridge service uninstall   # = unregister
```

## 故障排查

**机器人不响应**

1. 看日志：`tail -f ~/.lark-kiro-bridge/logs/$(date +%Y-%m-%d).log`
2. 检查飞书后台：应用是否上线、长连接「事件配置」是否包含 `im.message.receive_v1`
3. 用 `/status` 测试单聊：私聊机器人发 `/status`，应该立即出卡片
4. 群里只 `@bot` 才回复，不 @ 是设计行为
5. 同一个 app 跑了两个 bridge 进程时事件会随机分发：`lark-kiro-bridge ps` 看一眼，多余的 `kill`

**点按钮报「出错了，code: 200340」**

飞书后台没订阅卡片回调。去「事件与回调 → 回调配置」加上 `card.action.trigger`（卡片回传交互），订阅方式选「使用长连接接收回调」。

**卡片不更新（始终停在"⏳ 思考中"）**

- Kiro CLI 卡住了。`idleTimeoutMinutes` 默认 5 分钟会自动 kill；想立刻解决：`/stop` 或卡片上 `⏹ 终止` 按钮
- 自查：在终端跑 `kiro-cli chat --no-interactive --trust-all-tools "hi"`，应当 5–10 秒内返回

**`/cd` 报"路径不在白名单"**

把目标根加到 `workspace.allowedRoots`，重启 `lark-kiro-bridge restart`。

**Kiro 改错了项目**

`/status` 看 cwd 是不是你以为的；`/cd <正确目录>` 切过去再问。

**`/model` 报「无法获取模型列表」**

daemon 跑的环境 PATH 里没找到 `kiro-cli`。先确认终端能跑：`which kiro-cli`；如果不在标准 PATH 里，把绝对路径写到 `kiro.binPath`。

## 项目结构

```
lark-kiro-bridge/
├── src/
│   ├── lib/                     # 基础设施：路径、日志、配置、debounce、安全
│   ├── store/                   # JSON 持久化（带文件锁）
│   ├── lark/                    # 飞书 SDK 封装
│   │   ├── client.ts            # WS 长连接 + OpenAPI
│   │   ├── cardAction.ts        # card.action.trigger 事件解析
│   │   ├── media.ts             # 图片/文件下载
│   │   ├── parse.ts             # 消息事件解析
│   │   └── types.ts             # 业务层类型
│   ├── kiro/                    # spawn kiro-cli + 流解析 + 模型
│   │   ├── runner.ts            # 子进程封装（detached + killTree + watchdog）
│   │   ├── runState.ts          # 结构化运行状态（blocks/tools/reasoning）
│   │   ├── runStreamParser.ts   # stdout 状态机解析器
│   │   └── models.ts            # /model 列表查询 + 5 分钟缓存
│   ├── card/                    # 飞书卡片 v2 渲染
│   │   ├── runRenderer.ts       # RunState → 卡片 JSON（streaming_mode + 折叠面板）
│   │   ├── runCardController.ts # 一次任务的卡片生命周期
│   │   ├── toolRender.ts        # 单工具 header/body 渲染
│   │   ├── builders.ts          # 命令型卡片（/model /help /status /ws）
│   │   ├── schema.ts            # 旧版 simple done 卡片（保留兼容）
│   │   └── renderer.ts          # 旧版 CardRenderer（保留兼容）
│   ├── commands/                # 斜杠命令解析（含 typo 容错）
│   ├── core/                    # ChatPipeline + Dispatcher + bootstrap
│   ├── daemon/                  # launchd plist + 进程注册表
│   ├── cli.ts                   # commander 入口
│   └── index.ts                 # 库导出
├── bin/
│   └── lark-kiro-bridge.mjs     # CLI 启动壳
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

## 路线图

- v0.2：当前版（结构化卡片 + 按钮回调 + Slack-style 工具面板）
- v0.3：Linux systemd 守护、Windows Task Scheduler
- v0.3：扫码绑定飞书应用（PersonalAgent 类型），免去手填 App ID/Secret
- v0.3：群名 → 工作区的启发式默认（进 agenzo 群默认在 agenzo 目录）
- v0.4：飞书内 `/config` 表单管理 access policy，无需手编 JSON
- v0.4：语音输入（飞书 ASR）
- v1.0：服务器集中部署模式、多用户隔离、Web 管理面板

## License

MIT

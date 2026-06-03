# lark-kiro-bridge

## 0.9.0

### Minor Changes

- 迁移 Kiro 集成层到 ACP（Agent Client Protocol）

  把 Kiro 集成从「spawn `kiro-cli chat --no-interactive` + 正则解析 ANSI stdout」切换到基于 ACP 的 JSON-RPC 客户端（`kiro-cli acp`）：

  - 新增 `src/kiro/acp/`：JSON-RPC over stdio 客户端（messages / asyncQueue / client）
  - 工具调用改用 ACP 结构化事件（tool_call / tool_call_update）直驱卡片，不再靠文本解析——工具展示更准、更健壮
  - 会话续接用 ACP `session/load`（带 cwd + mcpServers），多轮对话不丢上下文
  - 删除 `runStreamParser.ts`（不再需要逆向 CLI 的人类可读输出）
  - prompt 失败正确传播为 error 终态，不再静默吞

  同时修复：引用回复 / 合并转发的上下文还原（拉取被引用消息内容，含 interactive 卡片正文），空任务卡片静默撤回。

## 0.8.0

### Minor Changes

- P0/P1 可靠性 + 体验升级

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 和
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

待发版的改动会先写在这里。

## [0.7.0] — 2026-05-25

### 新增（Added）

- **`/schedule new` 可视化定时任务表单**：让非技术同事（HR / 销售 / 行政等）也能在飞书里建定时任务，0 cron 表达式心智
  - 4 个字段（小时 / 分钟 / 内容 / 任务名）一张飞书表单卡填完即建
  - 当前覆盖「每天 H:M」频率，底层 `formToCron` 已实现 6 种频率（daily / weekday / weekly / monthly / once / custom）转换器，未来加 UI 入口零改动
  - 底层和 `/cron` 共享 `~/.lark-kiro-bridge/cron.json`：`/schedule new` 创建的任务可在 `/cron list` 里管理
  - cron store 加 `runOnce` 字段为「一次性任务」铺路，scheduler 触发后自动 unregister + delete
  - 新增 `src/cron/scheduleForm.ts` + `src/card/scheduleCard.ts`，31 个新单元测试
- **`/selftest` 健康检查命令**（别名 `/check`）：一键看 9 项配置和运行时状态，方便排查问题
  - 检查项：配置文件 / 数据目录 / kiro-cli 可达性 / WebSocket / 飞书 token / cron 存储 / 工作目录白名单 / 信任工具 / 当前用户访问权限
  - 纯查询，无副作用，3s 内完成；超时 / 单项失败不影响其他项
  - 报告卡片按等级（ok / warn / fail）配色，带底部排错指引（"WS 未连接 → /reconnect" 等）
  - 新增 `src/lib/selftest.ts` + `src/card/selftestCard.ts`，20 个新单元测试
- **SDK logger 适配 + debug 增强**：飞书 SDK 内部日志统一通过 pino 输出，终端格式不再混杂裸 `[info]: [ '...' ]`
  - `createSdkLoggerAdapter` 把 SDK 期望的 logger 接口包成 pino，noise 模式自动降级到 trace
  - `kiro-cli` spawn / stdout chunk / run finalize 加结构化 debug 日志，便于 `/doctor` 自诊断

### 修复（Fixed）

- **飞书 v2 form 卡片 200530 兼容**：form 内 `button` 必须带 `name` 属性，否则飞书客户端校验阶段直接拒发请求。修复 3 处历史 form 卡片：

  - `buildConfigFormCard` `/config` 提交按钮
  - `buildMemoryEditFormCard` `/steering edit` 保存按钮
  - `buildMemoryNewFormCard` `/steering new` 创建按钮

  之前用户反馈 `/config` 提交也报 200530，根因就在这里。参考 [zarazhangrui/feishu-claude-code-bridge v0.1.32](https://github.com/zarazhangrui/feishu-claude-code-bridge) 上游模板修复。

### 测试

全套 314 个单元测试通过（v0.6.0 时 254 个 → +60 个新增）。

## [0.6.0] — 2026-05-24

### 新增（Added）

- **`/cron` 定时任务**：在飞书内创建、列出、暂停、删除 cron 任务，到点自动调 Kiro 把结果发回原 chat
  - 支持三种表达式输入（按优先级匹配）：
    - **标准 cron 5 段**：`0 9 * * *`
    - **Shorthand**：`@daily / @hourly / @weekly / @monthly / @yearly / @midnight`
    - **中文关键词预设**：`每天9点 / 每天下午3点 / 每周一8点 / 工作日10点 / 周末10点 / 每月15号9点 / 每小时`
  - **不识别时让 Kiro 翻译**：弹「让 Kiro 翻译吗？」确认卡 → spawn 一次 kiro-cli 让它输出 cron → 翻译结果再来一张二次确认卡 → 用户点「创建」才落盘。两次确认避免误操作
  - 子命令：`add / rm / pause / resume / run / next / list / translate`，别名 `/schedule`
  - 卡片每行带【手动跑 / 暂停 / 删除】按钮，admin 可见
  - 触发时往原 chat 先发"⏰ 定时任务触发"提示卡，再走标准 runKiroTask 渲染结果（结构化卡片 / 流式 / 工具调用 panel 全部复用）
- 限制：单 chat ≤ 20 任务、全机 ≤ 100 任务、prompt ≤ 1000 字符
- 用 `croner` 作调度库，开启 `protect: true` 防上次还在跑下次又触发；不补偿漏触发（跟 GitHub Actions / AWS EventBridge 一致）
- 持久化：`~/.lark-kiro-bridge/cron.json`，bridge 重启自动加载并重新注册
- 新增 `src/cron/expression.ts`（解析器）+ `src/cron/store.ts`（持久化）+ `src/cron/scheduler.ts`（调度器）
- 44 个新单元测试（29 expression + 15 parse）

### 变更（Changed）

- `Dispatcher` 构造函数新增可选参数 `cronStore` / `cronScheduler`；不注入则 `/cron` 命令报"未启用"
- `bootstrap.ts` 启动时实例化 cron 模块、加载持久化任务、关闭时停掉调度器
- 新依赖：`croner@^9.0.0`

## [0.5.0] — 2026-05-24

### 新增（Added）

- **`/steering` 飞书内管理 Kiro 指令文件**：在飞书里列出 / 查看 / 编辑 / 新建 / 删除 `.kiro/steering/*.md`，无需打开 IDE
  - `list`：列出当前 scope 所有 steering 文件，每行展示 inclusion 策略（always / manual / fileMatch）+ 大小 + 操作按钮
  - `view <name>`：展示文件内容；超过 3000 字符自动截短并提示用本地编辑器
  - `edit <name>`：飞书表单（multi-line input，最大 5000 字符）直接改，提交即生效
  - `new <name>`：弹空白表单创建新文件；点列表底部「📝 新建」按钮也行
  - `rm <name>`：带二次确认的删除按钮
  - `--global` / `-g`：操作 `~/.kiro/steering/`（默认 project scope = 当前 cwd 下的 `.kiro/steering/`）
  - 别名：`/memory` `/mem`
- 安全校验：文件名只允许字母数字 + `. _ -`、强制 `.md` 后缀、禁止路径穿越（`../`）；内容大小上限 100KB
- admin only 写操作（list/view 只读，所有人可用）
- 新增 `src/memory/store.ts` + 24 个单元测试覆盖文件名校验、CRUD、frontmatter 解析

### 变更（Changed）

- help 卡片和 help 文本加入 `/steering` 命令说明
- 命令解析支持 `--global` / `-g` 参数和子命令灵活顺序（`/steering edit --global foo.md` 和 `/steering --global edit foo.md` 都能解析）

## [0.4.0] — 2026-05-24

### 新增（Added）

- **跨平台守护**：除 macOS launchd 外新增 Linux systemd `--user` 单元和 Windows Task Scheduler ONLOGON 任务实现，CLI 命令对外保持一致（`lark-kiro-bridge start/stop/restart/status`）
  - macOS：`~/Library/LaunchAgents/ai.lark-kiro-bridge.bot.plist`（不变）
  - Linux：`~/.config/systemd/user/lark-kiro-bridge.service`，需 `loginctl enable-linger $USER` 才能在登出后保活
  - Windows：任务名 `LarkKiroBridge.Bot`，启动器 `~/.lark-kiro-bridge/daemon-launcher.cmd`
- **`/ps` 飞书命令**：列出本机所有 bridge 进程，每行带「停止」按钮，标记当前回复消息的进程
- **`/exit <id|#>` 飞书命令**：停止指定 bridge 进程（admin only），按 shortId / pid / `#N` 寻址
  - 自己 → 优雅停止（daemon 守护下会自动重启）
  - 他人 → SIGTERM
- **`process.stop` card action**：`/ps` 卡片上的「停止 / 退出」按钮回调，admin 校验
- 新增内部抽象 `DaemonAdapter` 接口（`src/daemon/types.ts` + `index.ts` 路由），便于未来扩展更多平台

### 变更（Changed）

- `src/daemon/launchd.ts` 重构成 `launchdAdapter` 实现 `DaemonAdapter` 接口
- 把 `resolveBinPath` 抽到 `src/daemon/resolveBin.ts` 让三端复用
- 不支持的平台跑 daemon 命令时给友好提示，而不是直接崩溃

## [0.3.0] — 2026-05-24

### 新增（Added）

- **`/config` 飞书内表单**：管理员发 `/config` 看当前配置，点「编辑」弹表单卡片，可改 `allowedUsers` / `allowedChats` / `admins` / `requireMentionInGroup` / `idleTimeoutMinutes`，保存即时生效，无需重启
- **防自锁校验**：表单提交前会校验 submitter 是否在新的 admins / allowedUsers 列表里，避免一脚踢自己出去
- **rapid-fire 消息合并**：同 chat 200ms 内连发的多条消息会自动拼接成一次 Kiro 调用，避免每条都被前一条 abort 重跑
- 三层访问控制扩展：`isUserAllowed` 现在多接收 `chatType` 参数；**DM (p2p) 永远豁免 `allowedChats`**，确保管理员永远能 DM 改回配置
- 命令解析：`/config` `/cfg` `/settings` 都路由到 config 命令
- 飞书 cardAction 解析：现在能正确取 `form_value`（表单提交字段）

### 修复（Fixed）

- **语音输入回复啰嗦**：Kiro 看到 `[语音]` 前缀时会进入"调试场景"模式，回复一大段 ASR 系统状态而不是回答用户问题。改成在转写后追加一段简短 system 提示，约束 LLM「按用户日常对话的口语意图回答，不要谈论语音或转写本身」
- `lark-kiro-bridge --version` 之前硬编码 `0.1.0`，现在动态从 `package.json` 读真实版本
- README 路线图：把 ASR 从 v0.4 挪到 v0.2 已完成（之前漏写）
- README/英文版/前置条件：补充 `ffmpeg` + 飞书 ASR scope 说明

## [0.2.0] — 2026-05-24

### 新增（Added）

- **🆕 扫码创建飞书应用**：`lark-kiro-bridge run` 首次启动自动弹二维码，飞书 App 扫码同意即可完成应用创建 + 凭证写入 + 自动配置必要权限（30 秒上手，无需开发者后台手动操作）
- `init --manual` 选项：保留手动输入已有 App ID/Secret 的方式
- `init --app-id <id> --app-secret <secret>`：一行参数完成配置（CI 场景）
- 扫码用户自动加入 `access.admins` 列表，避免后续敏感命令对所有人开放
- 完整中英双语文档：`README.md` / `README.en.md` / `docs/ARCHITECTURE.md` / `docs/FAQ.md`
- 路线图更新：扫码绑定从 v0.3 提前到 v0.2 完成

### 变更（Changed）

- **结构化卡片重做**：每次工具调用一个独立 `collapsible_panel`，多调用 ≥3 自动折叠成总结，思考过程独立 panel
- 卡片配置 `streaming_mode: true` + `summary` 字段，支持飞书原生打字光标
- 进行中卡片底部加 `⏹ 终止` 按钮 + 实时状态指示（🧠/🧰/✍️）
- 单个工具 body 截断到 2.5KB，防止超过飞书 30KB 单 element 限制
- 工具 input 按类型智能渲染（Bash 用 ```bash code block，Read 自动用 `~/` 替换 home 路径）
- README 重新组织：增加 badges、TOC、真实场景对话、双语切换链接

### 移除（Removed）

- `outputFilter.ts` 和测试（功能已合并到 `runStreamParser.ts`）

## [0.1.0] — 2026-05-24

首次公开发布。

### 新增（Added）

#### 核心交互

- 飞书 / Lark 消息转发到本机 `kiro-cli chat`，回复通过流式卡片实时刷新
- 结构化运行卡片：每次工具调用一个独立 collapsible_panel（Read / Bash / Grep / WebFetch / …）
- 多个工具调用聚合：≥3 个时前面折叠成「☕ N 个工具调用」总结，最新一个完整展示
- `streaming_mode: true` + `summary` 字段，飞书显示原生打字光标和通知摘要
- 底部 footer 状态指示（🧠 思考中 / 🧰 调工具 / ✍️ 输出中）+ ⏹ 终止按钮

#### 工作区管理

- 工作目录方案 B：`(chatId, cwd) → kiroSessionId` 双层映射，切目录不丢上下文
- 命名工作区：`/ws save|use|list|remove` 快速切换
- 根目录白名单：`workspace.allowedRoots` 限制 `/cd` 范围

#### 斜杠命令（含别名容错）

- `/new` `/cd` `/pwd` `/status` `/stop` `/timeout` `/model` `/reconnect` `/doctor` `/help`
- `/ws list|save|use|remove`
- 别名：`/m`=`/model`, `/h`=`/help`, `/s`=`/status`, `/reset`=`/new`, `/abort`=`/stop` 等
- typo 容错：`/mode` `/modle` 都识别为 `/model`
- 未知 `/xxx` 命令原样转发给 Kiro

#### 命令型卡片（按钮回调）

- v2 交互卡片，按钮走 `card.action.trigger` 长连接回调
- `/model` 卡片：每行模型带「选用」蓝色按钮，主力 / 实验性 / 旧版分组折叠
- `/help` 卡片：底部「📊 状态 / 🎛️ 模型 / 🗂️ 工作区 / 🔄 重置会话」快捷按钮
- `/status` 卡片：底部按钮直接跳转模型/工作区/重置/停止
- `/ws list` 卡片：每行「切换」按钮

#### 多媒体输入

- 图片 / 文件自动下载到 `~/.lark-kiro-bridge/media/<chatId>/`，绝对路径喂给 Kiro
- 媒体文件 24h 后自动清理

#### 多模型管理

- `kiro chat --list-models` 查询，5 分钟缓存
- 短名补全：`/m sonnet-4.6` 自动补 `claude-` 前缀
- 模型选择写入 `config.kiro.model`，下条消息立即生效

#### 运维与稳定性

- **进程组 kill**：`detached: true` + `process.kill(-pid)` 杀掉 kiro-cli 全部子孙进程
- **Idle watchdog**：默认 5 分钟，可全局或 per-chat 覆盖
- **进程注册表**：`processes.json` 检测同 app 多实例，避免 WS 事件随机分发
- **三层访问控制**：`allowedUsers` / `allowedChats` / `admins` 白名单
- **macOS launchd daemon**：崩溃自动重启，登录自启
- **结构化日志**：NDJSON 按天滚动，超过 `logRetentionDays`（默认 7 天）启动时清理
- **`/doctor`**：把日志反喂给 Kiro 自诊断

#### CLI

- `init` `run` `config-show`
- `start` `stop` `restart` `status` `unregister`
- `service install|uninstall|start|stop|status`
- `ps` `kill <id> [--force]`

### 安全（Security）

- `~/.lark-kiro-bridge/config.json` 强制 mode `0600`
- 日志写入前敏感字段（appSecret、access token）脱敏
- 卡片回调 admin 写操作（`model.set` / `ws.use` / `session.new` 等）二次校验

### 测试

- 150 个单元测试（vitest）覆盖：命令解析（含 typo 容错）、卡片回调解析、消息解析、
  ASR、SessionStore 文件锁并发
- typecheck（tsc strict）+ biome lint 全过

### 已知限制

- 仅 macOS 守护进程支持（launchd）；Linux / Windows daemon 在路线图
- 飞书免费版租户不支持 ASR，语音输入在路线图
- 群里 `@all` 永不响应（设计行为）

[Unreleased]: https://github.com/walterwang0x01/lark-kiro-bridge/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/walterwang0x01/lark-kiro-bridge/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/walterwang0x01/lark-kiro-bridge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/walterwang0x01/lark-kiro-bridge/compare/v0.3.1...v0.4.0
[0.3.0]: https://github.com/walterwang0x01/lark-kiro-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/walterwang0x01/lark-kiro-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/walterwang0x01/lark-kiro-bridge/releases/tag/v0.1.0

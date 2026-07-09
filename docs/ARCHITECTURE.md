# 架构与设计

深入理解 **Bridge（lark-kiro-bridge）** 内部如何工作。普通用户**不需要看这份**，README 已经覆盖日常使用；这份是给想读源码、贡献代码、或在生产环境调优的人看的。

如果你想先理解整套 **LWA（Lark Local Agent Workbench）** 多 CLI 方案，而不是先看实现细节，先读 [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md) 和 [`runtime-routing-production.md`](./runtime-routing-production.md)。

## 整体数据流

```
┌──────────┐                        ┌─────────┐                    ┌───────────┐
│   飞书   │  ① WebSocket 长连接    │ bridge  │  ③ spawn 子进程    │ kiro-cli  │
│ (Lark)   │ ─────────────────────► │ daemon  │ ═══ JSON-RPC ════► │  acp      │
│          │ ◄───────────────────── │         │ ◄═══ (ACP) ═══════ │           │
└──────────┘  ⑤ 流式 patchCard      └─────────┘  ④ session/update  └───────────┘
                                         │
                              ② OpenAPI HTTPS │
                                         ▼
                                  ┌──────────┐
                                  │ 飞书 API │
                                  │ (open)   │
                                  └──────────┘
```

1. **入站事件**：飞书 → WebSocket 长连接（`im.message.receive_v1` + `card.action.trigger`）→ bridge `dispatcher`
2. **OpenAPI**：bridge → 飞书 HTTPS（发卡片、patch 卡片、下载图片资源、查机器人 open_id）
3. **spawn kiro-cli acp**：bridge 用 execa spawn `kiro-cli acp` 子进程，通过 stdin/stdout 跑 **ACP（Agent Client Protocol，JSON-RPC 2.0）**。每 turn 一个子进程：`initialize` → `session/load`（续接）或 `session/new` → `session/prompt`
4. **session/update 事件流**：kiro-cli 通过 ACP 通知推送结构化事件（`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update`）→ bridge 映射成 RunState；`session/prompt` 响应的 `stopReason` 表示 turn 结束
5. **流式 patchCard**：每次 RunState 变更 → 节流（800ms 默认）→ patch 飞书卡片（所有 patch 串行执行，保证终态不被覆盖）

## 卡片渲染体系

### 数据模型 RunState

每次 Kiro 任务一个对象，模型见 `src/kiro/runState.ts`：

```ts
interface RunState {
  blocks: Block[];        // 时序排列的 [文本块 | 工具调用块]
  reasoning: { content: string; active: boolean };
  terminal: 'running' | 'done' | 'error' | 'interrupted' | 'idle_timeout' | 'timeout';
  errorMsg?: string;
  footer: 'thinking' | 'tool_running' | 'streaming' | null;
  plan?: Plan;            // 任务计划（可选，渲染在卡片顶部）
}

interface ToolEntry {
  id: string;             // 稳定 id（用 ACP toolCallId）
  name: string;           // 'Read' / 'Bash' / 'Grep' / ...
  title?: string;         // Kiro 经 ACP 提供的真实标题（"Reading sample.txt:1"）
  kind?: string;          // ACP 工具类别（read/execute/edit），用于选图标
  purpose?: string;       // 调用目的（ACP rawInput.__tool_use_purpose）
  input: Record<string, unknown>;
  output?: string;        // 工具执行结果（ACP rawOutput/content 提取）
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
}
```

### ACP 事件映射

`src/kiro/acp/client.ts` 把 `kiro-cli acp` 的 JSON-RPC 通知解析成结构化 `SessionEvent`，`src/card/runCardController.ts` 的 `applyEvent` 再映射到 RunState：

| ACP 事件（`session/update` 的 `sessionUpdate`） | 映射 |
|---|---|
| `agent_message_chunk` | 追加到 text block（LLM 正文） |
| `agent_thought_chunk` | 写 reasoning（思考过程） |
| `tool_call` | 新建 ToolEntry（按 toolCallId）；提取 title/kind/purpose |
| `tool_call_update` | 按 toolCallId 更新状态 + 提取执行结果（rawOutput/content） |
| `session/prompt` 响应的 `stopReason` | turn 结束 |

相比旧的 stdout 解析，工具的名称、参数、状态、执行结果都来自 ACP 的**结构化字段**，不再靠正则猜人类可读文本——更准、更健壮，且对 MCP 工具同样适用。

> 历史：v0.9 之前用 `kiro-cli chat --no-interactive`，靠 `runStreamParser.ts` 正则解析 ANSI stdout（识别 `Reading file:` / `I will run …` / `- Completed in …` 等行）。该方式脆弱、信息有损，v0.9 迁移到 ACP 后已删除。

### 渲染策略

`src/card/runRenderer.ts` 按 RunState 渲染飞书 v2 卡片：

| 工具数 | 任务状态 | 渲染策略 |
|---|---|---|
| `< 3` | 任意 | 每个工具独立 collapsible_panel |
| `≥ 3` | running | 前面折叠成「☕ N 个工具调用」总结，最新一个完整展开 |
| `≥ 3` | finalized | 全部折叠成总结 |

视觉细节：
- **每个工具一个 collapsible_panel**，header 显示 `✅ Read — ~/path/to/file.md`
- 工具 input 按工具类型智能渲染（Bash 用 `**Command** ```bash ...````、Read 用 `**File** \`~/path\``、Grep 用 `**Pattern** \`xxx\` **Path** \`...\``）
- 错误工具：`border.color: 'red'`
- 思考过程：单独 panel，进行中默认展开
- 进行中状态：`config.streaming_mode: true`（飞书显示原生打字光标）+ `config.summary.content`（通知列表显示「正在调用工具」）
- 进行中底部：footer status（🧠/🧰/✍️）+ `⏹ 终止` 按钮

### 大小限制

防止超过飞书单 element 30KB 上限：

| 范围 | 上限 |
|---|---|
| 单个工具 header summary | 80 字符 |
| 单个 input 字段 | 600 字符 |
| 单个工具 output | 1200 字符 |
| 单个工具 body 总长 | 2500 字符 |

超出后截断，附「完整内容查 `/doctor` 或日志」。

## 工作目录方案 B

每个飞书 chat 维护一个 `(cwd → kiroSessionId)` 映射，**切目录不丢上下文**。

### 数据结构

`~/.lark-kiro-bridge/sessions.json`:

```json
{
  "version": 1,
  "chats": {
    "oc_xxxxx": {
      "currentCwd": "/Users/.../portfolio",
      "sessionsByCwd": {
        "/Users/.../portfolio": "kiro-sess-aaa",
        "/Users/.../agenzo":    "kiro-sess-bbb"
      },
      "lastActiveAt": 1779543920519,
      "idleTimeoutMinutes": null
    }
  }
}
```

### 行为

1. **切目录不丢上下文**：你 `/cd ~/Projects/agenzo` 后，portfolio 那条 Kiro session 还在；切回去自动续聊（ACP `session/load` 那条 cwd 对应的 sid）
2. **每个 (chat, cwd) 独立 session**：不同群、不同目录之间不会串话
3. **命名工作区只是别名**：`/ws save brand → /Users/.../personal-brand-agent`，之后 `/ws use brand` 等同于 `/cd /Users/.../personal-brand-agent`
4. **per-chat watchdog 覆盖**：`/timeout 10` 只影响当前 chat

### 文件锁

`src/store/sessions.ts` 用 `proper-lockfile` 保证多进程并发写不损坏文件——理论上你不会同时跑两个 daemon，但万一有（比如同 app 双实例），数据安全。

## 进程管理

### 子进程终止

ACP 模式下每 turn spawn 一个 `kiro-cli acp` 子进程(长连接,跑完即 close)。中止/超时的终止流程见 `src/kiro/runner.ts`:

```ts
// 1) 优雅:先发 ACP session/cancel
client.cancel(sessionId);
// 2) 兜底:2 秒后 close() → SIGTERM,再 5 秒后 SIGKILL
setTimeout(() => client.close(), 2000);  // close 内部 SIGTERM → 5s 后 SIGKILL
```

相比旧 stdout 模式(`detached` 进程组 + `process.kill(-pid)` 杀子孙),ACP 子进程是单一长连接进程,直接 `proc.kill` 即可,不再需要进程组。

### Idle Watchdog

每 30 秒检查 `Date.now() - lastEventAt`(最后一个 SessionEvent 到达时间),超过阈值则 cancel + 兜底强杀。

阈值优先级：per-chat 覆盖（`/timeout 10`） > 全局 `kiro.idleTimeoutMinutes` > 0（关闭）

### 多实例检测

`~/.lark-kiro-bridge/processes.json` 注册当前进程。启动时扫描同 appId 的存活进程，发现重复 → 警告（不阻断启动，但用户应手动 `kill` 多余的）。

为啥重要：飞书 WS 同 app 两个连接时事件**随机路由**，会出现"机器人有时回复有时不回复"。

## 命令型卡片回调

`/model`、`/help`、`/status`、`/ws list` 卡片上的按钮走 `card.action.trigger` 事件。

### 流程

1. 用户点按钮 → 飞书推送 `card.action.trigger` 事件 → bridge `dispatcher.handleCardAction`
2. 按钮 value 字段约定：`{ action: 'model.set', name: 'claude-sonnet-4.6' }`
3. 路由到对应 handler，admin 写操作走 admin 校验
4. 执行后发新卡片回执（`✅ 模型已切换`）

### Action 清单

| action | 写操作？admin? | 说明 |
|---|---|---|
| `model.show` | 否 | 重发 model picker |
| `model.set` | **是** | 切模型 + 写 config.json |
| `model.reset` | **是** | 清模型覆盖 |
| `model.refresh` | 否 | 清缓存重新查 |
| `session.new` | **是** | 重置当前 chat 会话 |
| `session.stop` | 否 | 中止当前任务 |
| `session.status` | 否 | 重发 status 卡片 |
| `ws.list` | 否 | 重发 ws-list 卡片 |
| `ws.use` | **是** | 切换工作区 |

## Web Dashboard

只读状态面板，`bootstrap.ts` 里 `startDashboard()` 跟 event loop 一起起，独立于飞书连接，飞书断线不影响它。

### 为啥是 Node 内置 http，不是 express/fastify

只有一个 GET JSON 端点 + 静态文件托管，引入 web 框架换不来什么，多一层依赖和攻击面。`node:http` 的 `createServer` 够用。

### 为啥前端是独立的 Vue + Vite 子项目，不是内嵌字符串 HTML

最早版本（v0.10 之前的一个中间版本）确实试过内嵌 HTML 字符串（vanilla JS + fetch，零构建），能跑但排版和交互都简陋——vanilla 版本没有组件化、状态管理靠手写 DOM 操作，加一个可搜索的技能列表就得手写过滤逻辑。改成独立 Vue 子项目后：

- 复用作者在其他项目（agenzo 系）已经用熟的 Vue 3 + Tailwind 组合
- 构建产物是静态文件（JS 27KB / CSS 3KB，gzip 后），随 npm 包分发，**终端用户不需要装 Vue/Vite**——`npm install -g lark-kiro-bridge` 后 `dist/dashboard-ui/` 已经是编译好的静态资源
- 组件化让"技能搜索框""日志流""定时任务开关点"这类交互写起来自然，不用手搭一套响应式框架

代价：多一套构建链（`dashboard-ui/` 有自己的 `package.json` / `vite.config.ts`），`pnpm build` 要先构建前端再 tsup 打包主包再拷贝产物（见 `scripts/copy-dashboard-ui.mjs`）。对一个只读小面板这个代价可接受；如果只是想看一眼数据不追求交互体验，这个决策可以重新评估。

### 运行时路径解析的坑：tsup 单文件 bundle

tsup 把整个包打成单文件（`dist/cli.js` / `dist/index.js`），**不保留 `src/` 的目录结构**。这意味着 `server.ts` 运行时 `import.meta.url` 指向的是 `dist/cli.js`，不是"看起来应该"的 `dist/dashboard/server.js`。

```ts
// src/dashboard/server.ts
const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIST_CANDIDATES = [
  join(HERE, 'dashboard-ui'),                       // 生产：dist/ → dist/dashboard-ui/
  join(HERE, '..', '..', 'dashboard-ui', 'dist'),    // 开发：src/dashboard/ → dashboard-ui/dist/
];
```

两个候选路径都探测一下，谁先命中用谁——这不是防御性编程的过度设计，是**真的踩过坑**：第一版按"独立编译文件"的直觉写的路径，构建后能跑但页面加载的是源码目录里指向 `/src/main.ts` 的开发版 HTML（因为路径算错，意外命中了项目根的 `dashboard-ui/` 源码目录）。只有真实重启 daemon + curl 验证才发现，类型检查和单元测试都测不出这类"运行时路径算错但两条分支都语法合法"的 bug。

### API 契约

`GET /api/overview` 返回一份快照（不是流式/WS），前端 5 秒轮询：

```ts
interface Overview {
  bridge: { pid; appId; startedAt; uptimeSec; now };
  sessions: SessionSummary[];   // 复用 SessionStore.listAll()
  cron: CronSummary[];           // 复用 CronStore.list()
  processes: ProcessSummary[];   // 复用 daemon/registry.ts 的 listProcesses()
  skills: SkillSummary[];        // 新增：解析 ~/.kiro/skills/*/SKILL.md
  logs: string[];                // 复用 readRecentLogLines(120)
}
```

契约没有共享类型定义——`dashboard-ui/src/types.ts` 是手写的前端侧副本，改后端字段时要记得同步。两个项目用不同的 tsc 配置（`vue-tsc` vs `tsc`），当前规模（一个接口、五个字段）没必要为此引入 monorepo 级别的类型共享方案。

### 技能解析的一个真实坑：YAML 块语法

`~/.kiro/skills/*/SKILL.md` 的 frontmatter 里 `description` 字段有两种写法：

```yaml
description: "单行或带转义换行的引号字符串"
```
```yaml
description: >-
  YAML 折叠块语法，后续缩进行拼成一段，
  换行会被折叠成空格。
```

第一版解析只处理了引号字符串，用真实数据跑（`~/.kiro/skills/fireworks-tech-graph/`）才发现有 skill 用的是块语法，解析结果是乱码 `>-`。`src/dashboard/skills.ts` 的 `parseFrontmatter()` 现在两种都处理，不引入 YAML 解析库（就两个字段，够用的正则/逐行处理成本更低）。

### 安全边界

见 [SECURITY.md](../SECURITY.md#web-dashboard-local-http-server)：绑定 `127.0.0.1`、纯只读、不返回 secret、静态文件路径穿越防护。

## `/conduit`：串联 kiro-conduit

[kiro-conduit](https://github.com/walterwang0x01/kiro-conduit) 是同作者的另一个项目——多 agent DAG 并行编排器（把大 spec 拆成任务图，多个 worktree 并行跑 Kiro，CIV 三角色 + 4 层验证，串行 merge）。lark-kiro-bridge 不重新实现这套编排逻辑，只是把它接进飞书交互。

### 串联方式：spawn 子进程，不是库依赖

`src/conduit/runner.ts` 的 `runConduit()` 用 execa spawn `kiro-conduit`（PATH 上的可执行文件，可用 `KIRO_CONDUIT_BIN` 环境变量覆盖成绝对路径），跟 bridge 调 `kiro-cli` / `lark-cli` 是同一个模式——**统一走"外部工具子进程"**，不引入 Python 互操作或者把 conduit 的逻辑搬进 bridge。

前提：`kiro-conduit` 命令要在 PATH 上（`uv tool install` 或 `pipx install` 装一次）。bridge 不负责装它，只负责调。

### 为啥不直接 npm 依赖

kiro-conduit 是 Python 项目（asyncio + Kiro CLI ACP 编排），bridge 是 TypeScript/Node 项目——两个不同的运行时，没有"直接 import"这个选项，子进程是唯一合理的集成方式。这也符合 bridge 一贯的设计：不做 LLM/agent 编排本身（那是 kiro-cli 和 kiro-conduit 的工作），bridge 只做"消息转发 + 卡片渲染 + 外部工具调度"。

### 三个安全设计

1. **`run` 默认不 `--merge`**：只产出分支供 review，绝不自动改用户的 base branch。要合并必须显式 `/conduit run --merge`。
2. **`--merge` 强制二次确认**：合并是不可逆操作（会改 base branch），`handleConduitCmd` 弹一张橙色警告卡片（`buildConduitMergeConfirmCard`），用户点「确认」才真正执行，按钮 value 走 `conduit.confirmMerge` action，跟 `/schedule new`、`/cron translate` 的二次确认模式一致。
3. **走 ChatPipeline，可被打断**：conduit 是分钟级长任务，不能让它把 chat 卡死。`run`/`run --merge` 都通过 `pipeline.submit()` 提交，跟普通 Kiro 任务一样——新消息或 `/stop` 会触发 `AbortSignal`，`runConduit` 把它转成 execa 的 `cancelSignal`（SIGTERM，5s 后兜底 SIGKILL）。

### 一个真实修过的 bug：SIGTERM 不会传播清理

第一版只是把 `AbortSignal` 传给 execa，测试时发现：**卡片显示"⏹ 已中止"，但 conduit 进程和它已经 spawn 的 kiro-cli 子进程还在跑**。

根因在 kiro-conduit 那一侧：它从未注册过信号处理器。Python 收到 SIGTERM 默认直接终止进程，正在跑的 `async with await AcpClient.spawn(...)` 块的 `__aexit__`（负责 terminate 子进程）根本来不及执行。

修法是在 kiro-conduit 的 `cli.py` 加 `_run_with_signal_handling()`：把 SIGTERM/SIGINT 转换成对 asyncio 主 task 的 `cancel()`。取消会像异常一样沿 await 链传播，途经的每个 `async with AcpClient` 块的 `__aexit__` 正常触发。**没有改动 orchestrator / AcpClient 本身**——它们的清理路径本来就是对的，只是从来没被信号真正触发过。

过程中还顺手改坏又修好了一件事：手动 `loop.create_task()` 替代 `asyncio.run()` 后，`main()` 对外一贯的 `raise SystemExit`（既有测试依赖这个契约）被意外吞成了 int 返回值，得显式 `except SystemExit: raise` 才恢复。这是"改一处基础设施代码，牵连到看似无关的错误处理路径"的典型例子——只跑类型检查看不出来，得跑既有测试套件才抓到。

### 流式进度

`runConduit` 支持 `onProgress` 回调，边跑边把 stdout/stderr 合并后的尾部（截断到 2500 字符）喂给调用方。`handleConduitCmd` 用它节流（2 秒一次）刷新占位卡片，避免飞书 `patchCard` 频率限制。这不是真正的结构化进度（kiro-conduit 内部有 EventBus 记录 wave/worker 状态，但 CLI 层只吐文本日志），只是"看得到它还活着、大概在干什么"，够用但不精确。

## `/skill` 与 `/agent`：Skill 市场与 Persona 系统

这两块都建立在 Kiro CLI 的原生机制上，bridge 只做"发现 / 分发 / 切换"的交互层，不重新发明配置格式。

### 共享底层：GitAssetSource

Skill 和 Persona 的团队分发共用 `src/assets/gitSource.ts`——两者本质上是同一个流程（clone/pull 一个 Git 仓库 → 发现候选资产 → 确认后安装到 Kiro 标准目录 → 记录来源），只在两点上有差异：

| | Skill | Persona（Agent_Config） |
|---|---|---|
| 候选识别 | 含 `SKILL.md` 的子目录 | `*.json` 文件 |
| 安装目标 | `~/.kiro/skills/<name>/` | `~/.kiro/agents/<name>.json` |

其余（git 操作、确认流程、`asset-installs.json` 记录）完全共享。来源注册和安装记录持久化在 `src/assets/store.ts`（zod schema + `proper-lockfile`，模式同 `store/workspaces.ts`），文件落在 `~/.lark-kiro-bridge/asset-sources.json` 和 `asset-installs.json`，clone 缓存在 `~/.lark-kiro-bridge/asset-sources/<name>/`。

### 安全设计

- **技术路径选"复用 Git 生态"而非自建 Registry**：Skill_Source / Persona_Source 就是 Git 仓库地址，`git clone`/`pull` 到本机，私有仓库的鉴权完全委托给用户机器已配好的 git credential / SSH key，bridge 不做账号体系。这避免了自建中心化索引服务的托管、审核、运维成本（不符合单人维护项目的现实）。
- **未确认不写入**：`syncSource()` 只 clone/pull + 列候选，绝不安装；安装必须由 `installAsset()` 显式触发（命令 / 卡片按钮）。
- **不覆盖已存在资产**：`installAsset()` 目标已存在同名资产时返回 `{ installed: false }`，绝不覆盖用户已有的自定义内容。Persona_Library 的默认角色安装走同一条保护逻辑。
- **供应链风险提示**：安装第三方资产前，卡片固定展示来源地址 + "内容未经审核"标注 + 风险提示（Agent_Config 额外提示 `prompt` 可能诱导模型偏离职责、`tools`/`mcpServers` 可能授予超预期的工具权限）。这是对 ClawHub 已发生过的恶意 Skill 事件的直接防御。

### Persona 切换机制：接线已有的死字段

核实代码发现 `config.kiro.agent` 和 `RunOptions.agent` 早就声明了但从未接线——`runKiro()` 没把 `agent` 拼进 ACP 启动参数。本次三处最小改动接通：`AcpClientConfig` 加 `agent` 字段、`spawn()` 拼 `--agent`、Dispatcher 构造 AcpPool 时传入 `config.kiro.agent`。`/agent` 命令复用 `/model` 已验证的模式（全局配置覆盖 + 下一条消息生效）。

一个关键修正：`/agent set`/`reset` 会主动 `acpPool.evict(chatId)`。因为 AcpPool 是常驻进程池，切换配置后若不 evict，已存活的 chat 进程仍用旧 agent——`/model` 命令目前就有这个未修的时机问题，`/agent` 通过 evict 规避了它。

### Persona_Library：随包分发的默认角色

`src/kiro/personaLibrary/` 提供两个默认角色（客服问答 `customer-service`、代码审查 `code-reviewer`），JSON 内容用静态 `import` 内联进 tsup bundle（避免打包后运行时按路径找不到文件）。`/agent install-defaults` 命令按"已存在则跳过"逻辑写入 `~/.kiro/agents/`，不在启动时自动写用户目录（未经同意不动用户文件系统）。

## 项目目录

```
src/
├── lib/                       # 基础设施
│   ├── paths.ts               # 数据目录路径常量
│   ├── logger.ts              # pino 结构化日志 + 启动清理
│   ├── config.ts              # zod schema + 加载 + 原子保存
│   ├── debounce.ts            # 流式更新节流
│   └── security.ts            # cwd 白名单 + admin 校验
├── store/                     # JSON 持久化（带文件锁）
│   ├── sessions.ts            # ChatSession × KiroSession 映射
│   └── workspaces.ts          # 命名工作区映射
├── lark/                      # 飞书 SDK 封装
│   ├── client.ts              # WS 长连接 + OpenAPI
│   ├── cardAction.ts          # card.action.trigger 事件解析
│   ├── media.ts               # 图片/文件下载 + 24h 清理
│   ├── parse.ts               # 消息事件解析
│   └── types.ts               # 业务层类型
├── kiro/                      # ACP 客户端 + runner + 模型
│   ├── acp/
│   │   ├── messages.ts        # ACP 协议类型（JSON-RPC / SessionEvent / 常量）
│   │   ├── asyncQueue.ts      # 最小异步队列（事件流 backpressure）
│   │   └── client.ts          # AcpClient：kiro-cli acp 子进程 + JSON-RPC over stdio
│   ├── runner.ts              # 每 turn 跑一次 ACP（initialize→load/new→prompt + watchdog）
│   ├── runState.ts            # 结构化运行状态（blocks/tools/reasoning）
│   └── models.ts              # /model 列表查询 + 5 分钟缓存
├── card/                      # 飞书卡片 v2 渲染
│   ├── runRenderer.ts         # RunState → 卡片 JSON
│   ├── runCardController.ts   # 一次任务的卡片生命周期
│   ├── toolRender.ts          # 单工具 header/body 渲染
│   ├── builders.ts            # 命令型卡片（/model /help /status /ws）
│   ├── schema.ts              # 旧版 simple done 卡片（保留兼容）
│   └── renderer.ts            # 旧版 CardRenderer（保留兼容）
├── commands/                  # 斜杠命令解析
│   ├── parse.ts               # 命令解析器（typo 容错）
│   └── help.ts                # /help 文本（已被 builders.ts 替代）
├── core/                      # 核心调度
│   ├── pipeline.ts            # ChatPipeline（per-chat 串行 + preempt）
│   ├── dispatcher.ts          # 总分发器
│   └── bootstrap.ts           # 启动装配
├── daemon/                    # macOS launchd
│   ├── launchd.ts             # plist 安装 / start / stop
│   └── registry.ts            # 进程注册表
├── conduit/                   # kiro-conduit 子进程封装
│   └── runner.ts              # spawn + signal 转发 + 流式输出回调
├── dashboard/                 # 只读 Web Dashboard 后端
│   ├── server.ts              # HTTP server：静态托管 + /api/overview
│   └── skills.ts              # 解析 ~/.kiro/skills/*/SKILL.md frontmatter
├── cli.ts                     # commander CLI 入口
└── index.ts                   # 库导出（程序化嵌入用）

dashboard-ui/                  # 独立 Vue 3 + Vite 子项目（见下文「Web Dashboard」一节）
├── src/
│   ├── App.vue
│   ├── components/            # Panel 外壳 + 各数据面板（Sessions/Cron/Processes/Skills/Logs）
│   ├── composables/useOverview.ts  # 5s 轮询 /api/overview
│   └── types.ts               # 前端侧的 API 契约副本（手动跟后端保持一致）
└── vite.config.ts
```

## 设计取舍记录

### 为啥 cwd 不存到 kiro-cli 的 session 里

kiro-cli 自己的 session 是按 cwd 启动的（ACP `session/new` 的 `cwd` 决定工作目录，`session/load` 续接时也要传同一 cwd）。我们额外在 sessions.json 维护 `(chatId, cwd) → sid` 映射，**目的是让用户在飞书里 `/cd` 切目录时不丢上下文**——切回原目录能直接 `session/load` resume，不需要再次设置 prompt。

### 为啥不用 webhook 模式

WS 长连接：
- 不需要公网 IP
- 不需要域名 / HTTPS 证书
- 飞书侧负责重连
- 适合本机 / 内网部署

webhook 适合云上部署多实例集群——这不是 lark-kiro-bridge 的目标场景。

### 为啥每个 chat 串行而不是并发

- LLM 模型对话上下文是有时序的——用户发 1、2、3 三条消息，期望 LLM 按顺序回（而不是 3 先回 1 后回）
- 同 chat 跑两个 kiro-cli 子进程会争抢 session 资源，容易乱
- ChatPipeline 设计：新消息 abort 旧任务（preempt），保证最新意图最先响应

### 为啥不用 vercel ai sdk / langchain

我们不在 bridge 层做 LLM 编排——这是 kiro-cli 的工作。bridge 只做"消息转发 + 卡片渲染"，保持极简，复杂的工具调用 / agent loop 全交给 kiro-cli 处理。

## 参考资料

- [飞书卡片 JSON 2.0](https://open.feishu.cn/document/feishu-cards/feishu-card-overview)
- [飞书卡片回传交互](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)
- [kiro-conduit](https://github.com/walterwang0x01/kiro-conduit) —— `/conduit` 串联的多 agent 并行编排器，架构细节见其自己的 `docs/ARCHITECTURE.md`

# Design Document

## Overview

本设计落实 requirements.md 中已确认的决策：Skill_Marketplace 和 Persona_System 都扩展到他人及团队场景，技术路径统一选择"复用 Git 生态"，Persona_System 做成完整产品（切换机制 + 默认角色内容资产 + 团队分发）。

两个方向共享同一套底层机制——**Git 资产分发**（clone/pull 一个 Git 仓库，发现里面的候选资产，确认后安装到 Kiro 的标准目录）。区别只在于资产的形态（Skill 目录 vs Agent_Config JSON 文件）和安装目标目录。因此本设计先定义一个通用的 `GitAssetSource` 模块，Skill_Marketplace 和 Persona_System 的分发功能都基于它实现，避免重复造两套几乎一样的 clone/确认/安装流程。

Persona_System 的切换机制部分复用 `/model` 命令已验证的实现模式（全局配置覆盖 + 卡片确认 + 下一条消息生效），并修正一个 `/model` 现存但本次不动的时机问题（见"已知设计取舍"）。

## Architecture

```
飞书命令层（parse.ts）
  /skill  list | source add/list/remove | sync <source> | install <name>
  /agent  show | <name> | create <name> | reset | sync <source> | install <name>
       │
       ▼
Dispatcher（handleSkillCmd / handleAgentCmd，新增，仿 handleModelCmd 模式）
       │
       ├─► GitAssetSource（新增通用模块）─── git clone/pull ──► ~/.lark-kiro-bridge/asset-sources/<name>/
       │        │                                                        │
       │        │ listCandidates(source)                                 │ 本地缓存，只读探测，不影响已加载的 Kiro 资产
       │        ▼
       │   候选资产列表 → 确认卡片（复用 Requirement 3 安全提示）→ 用户确认
       │        │
       │        ▼ install(source, assetName)
       │   ~/.kiro/skills/<name>/          （Skill_Marketplace 安装目标）
       │   ~/.kiro/agents/<name>.json      （Persona_System 安装目标）
       │        │
       │        ▼ 记录
       │   ~/.lark-kiro-bridge/asset-installs.json（来源 + 安装时间，Dashboard 展示）
       │
       └─► Persona 切换机制
                config.kiro.agent（已存在字段，本次接线）
                     │
                     ▼
                runKiro() → AcpClient.spawn({ ...agent })→ kiro-cli acp --agent <name>
                     │
                     └─► acpPool.evict(chatId) 确保下一条消息用新 agent 重新 spawn
```

## Components and Interfaces

### 1. GitAssetSource（新增：`src/assets/gitSource.ts`）

Skill 和 Persona 的团队分发共用的底层模块。职责边界：只管"同步 Git 仓库 + 发现候选资产 + 安装 + 记录"，不关心资产内容本身怎么解析。

```typescript
export type AssetKind = 'skill' | 'agent';

export interface AssetSourceEntry {
  name: string;       // 用户起的别名，如 "team-skills"
  gitUrl: string;
  kind: AssetKind;
  addedAt: number;
}

export interface AssetCandidate {
  /** skill: 目录名；agent: 文件名去掉 .json */
  id: string;
  /** 展示用摘要：skill 取 SKILL.md 的 description；agent 取 prompt 前 80 字符 */
  summary: string;
  /** 本次 sync 后是新增还是已存在（用于卡片里标注"新"） */
  isNew: boolean;
}

export interface AssetInstallRecord {
  assetKind: AssetKind;
  assetId: string;
  sourceName: string;
  sourceGitUrl: string;
  installedAt: number;
}

export class GitAssetSource {
  addSource(entry: Omit<AssetSourceEntry, 'addedAt'>): void;
  listSources(kind?: AssetKind): AssetSourceEntry[];
  removeSource(name: string): boolean;

  /** git clone（首次）或 git pull（已存在），到 ~/.lark-kiro-bridge/asset-sources/<name>/ */
  sync(sourceName: string): Promise<AssetCandidate[]>;

  /** 把 sync 后缓存目录里的一个候选资产复制到 Kiro 标准目录；不覆盖已存在同名资产 */
  install(sourceName: string, assetId: string): Promise<{ installed: boolean; reason?: string }>;

  listInstalls(kind?: AssetKind): AssetInstallRecord[];
}
```

持久化文件（新增，遵循 `src/lib/paths.ts` 现有约定）：
- `~/.lark-kiro-bridge/asset-sources.json`：`AssetSourceEntry[]`
- `~/.lark-kiro-bridge/asset-installs.json`：`AssetInstallRecord[]`
- `~/.lark-kiro-bridge/asset-sources/<name>/`：git clone 的本地缓存目录（`.gitignore` 排除，不随包分发）

`sync()` 内部：`kind==='skill'` 时扫描缓存目录下每个含 `SKILL.md` 的子目录；`kind==='agent'` 时扫描每个 `*.json` 文件。这是 GitAssetSource 里唯二区分 kind 的地方，其余逻辑（git 操作、确认流程、安装记录）完全共享。

`install()` 目标目录：`kind==='skill'` → `~/.kiro/skills/<assetId>/`；`kind==='agent'` → `~/.kiro/agents/<assetId>.json`。已存在同名资产时返回 `{ installed: false, reason: '已存在，未覆盖' }`（对应 Requirement 7.3 的"不覆盖已存在自定义"要求，Persona_Library 默认角色安装复用同一条 install 路径）。

Git 操作用现有依赖 `execa` spawn `git clone`/`git pull`，不新增依赖。私有仓库的鉴权完全委托给用户机器已配置好的 git credential / SSH key，Bridge 不做任何账号体系（对应 Requirement 2.3）。

### 2. Skill_Marketplace 命令面

`src/commands/parse.ts` 新增 `ParsedCommand` 分支：

```
/skill                          → list（复用现有 listGlobalSkills，已存在能力，无需改）
/skill source add <name> <url>  → source-add
/skill source list              → source-list
/skill source rm <name>         → source-remove
/skill sync <name>              → sync（clone/pull + 列候选，弹确认卡片）
/skill install <name> <assetId> → install（对某个已 sync 的候选资产单独确认安装；也支持从确认卡片按钮直接触发同一 action）
```

`src/core/dispatcher.ts` 新增 `handleSkillCmd`，`source add/list/rm` 直接操作 `GitAssetSource`；`sync` 触发 `sync()` 后用新建的 `buildAssetSyncCard`（见下）展示候选列表，每个候选带"安装"按钮，按钮 value 为 `{ action: 'skill.install', source, assetId }`。

### 3. Persona 死字段接线（Requirement 5.1）

三处最小改动，复用 `model` 已有的接线模式：

- `src/kiro/acp/client.ts`：`AcpClientConfig` 加 `agent?: string`；`spawn()` 里 `if (config.agent) args.push('--agent', config.agent)`（紧跟在现有 `if (config.model) args.push('--model', config.model)` 之后）
- `src/kiro/runner.ts`：`runKiro()` 的参数解构加入 `agent`，自管模式的 `spawnCfg` 加 `if (agent) spawnCfg.agent = agent`（池化模式下 agent 已经在 spawn 时通过 `AcpPool.clientConfig` 传入，见下一条）
- `src/core/dispatcher.ts` constructor：`new AcpPool({ clientConfig: { binPath, model, agent: this.config.kiro.agent } })`

### 4. Persona 命令面（Requirement 5.2/5.3/5.4、Requirement 6）

`src/commands/parse.ts`：把 `'agent'` 从 `KIRO_INTERNAL_COMMANDS` 移除，新增分支：

```
/agent                    → show（列出 ~/.kiro/agents/ 下所有 Agent_Config + 当前生效）
/agent <name>             → set
/agent create <name>      → create-start（进入下面「创建流程」）
/agent reset              → reset
/agent sync <source>      → sync（同 skill，复用 GitAssetSource，kind='agent'）
/agent install-defaults   → install-defaults（安装 Persona_Library，见组件 5）
```

`src/kiro/agents.ts`（新增，结构对标 `src/dashboard/skills.ts` 的 `listGlobalSkills`）：

```typescript
export interface AgentSummary {
  name: string;        // 文件名去掉 .json
  promptPreview: string; // prompt 字段前 80 字符，无 prompt 则 "（无描述）"
}
export function listGlobalAgents(): AgentSummary[];
```

`src/core/dispatcher.ts` 新增 `handleAgentCmd`，结构对照 `handleModelCmd`：

- **show**：`listGlobalAgents()` 为空时提示"未发现任何 Agent_Config，可用 `/agent install-defaults` 安装默认角色库"；非空则用新建的 `buildAgentPickerCard`（结构对照 `buildModelPickerCard`）列出全部 + 当前生效（`config.kiro.agent` 或"未设置，使用 Kiro 默认"）
- **set**：校验 `~/.kiro/agents/<name>.json` 存在，不存在则报错并列出可用名称（Requirement 6.2）；存在则 `patchAndSaveConfig` 写 `config.kiro.agent = name`，**并 `await this.acpPool.evict(msg.chatId)`**——这是本设计对 `/model` 现有模式的修正，确保"下一条消息生效"这句话是真的（见"已知设计取舍"）
- **reset**：清除 `config.kiro.agent` 覆盖，同样 evict 当前 chat
- **create**：`/agent create <name>` 后，飞书侧没有多行文本输入命令的自然方式，采用跟 `/schedule new` 一致的模式——回一张表单卡片（`buildAgentCreateFormCard`，新增），带一个多行文本输入组件填 prompt；提交走 `agent.createSubmit` action，写入 `~/.kiro/agents/<name>.json`（仅含 `prompt` 字段），若同名文件已存在则拒绝并提示改用手动编辑（不覆盖，对应非目标里"编辑器只做简单场景"的边界）
- **sync / install**：复用 `GitAssetSource`，卡片 action 前缀换成 `agent.sync`/`agent.install`，安全确认文案见下方"安全设计"

卡片按钮 action 处理（`onCardAction`）新增 `agent.set` / `agent.reset` / `agent.createSubmit` / `agent.sync` / `agent.install`，结构对照现有 `model.set` / `model.reset`。`actionNeedsAdmin()` 里这些 action 全部要求 admin（跟 `model.set`/`model.reset` 一致，因为都是全局配置变更）。

`buildStatusCard`（`src/card/builders.ts`，已存在函数）新增一个可选字段 `currentAgent`，`/status` 命令调用处传入 `config.kiro.agent`（Requirement 6.4）。

### 5. Persona_Library（Requirement 7）

新增 `src/kiro/personaLibrary/`：

```
src/kiro/personaLibrary/
  customer-service.json   { "prompt": "...", "tools": [...] }
  code-reviewer.json      { "prompt": "...", "tools": [...] }
  index.ts                export function listPersonaLibrary(): Array<{ name: string; config: object }>
```

`/agent install-defaults` 命令逐个调用跟 `GitAssetSource.install` 相同的"目标文件已存在则跳过"逻辑，写入 `~/.kiro/agents/`。不在 bootstrap 阶段自动安装（避免未经用户同意就往用户目录写文件），只能通过命令主动触发，安装结果用 `buildAckCard` 汇总"已安装 N 个，跳过 M 个已存在的"。

内容资产随 npm 包发布（加入 `package.json` 的 `files` 字段），版本管理即 Bridge 自身的版本管理，不新增独立发布流程。

### 6. Dashboard 扩展

`src/dashboard/server.ts` 的 `buildOverview()` 新增 `agents: listGlobalAgents()` 和 `assetInstalls: gitAssetSource.listInstalls()` 两个字段（对应 Requirement 5.3 的 Dashboard 只读列表、Requirement 3.4/8 的安装记录展示）。前端 `dashboard-ui` 加一个 Agents 面板，结构对照现有 Skills 面板。

## Data Models

```typescript
// ~/.lark-kiro-bridge/asset-sources.json
{ "version": 1, "sources": AssetSourceEntry[] }

// ~/.lark-kiro-bridge/asset-installs.json
{ "version": 1, "installs": AssetInstallRecord[] }
```

两个文件都用 zod schema 校验 + `proper-lockfile` 加锁，模式完全照抄 `src/store/workspaces.ts` 的 `readFile`/`writeFile`/`withLock`（该文件已验证过并发安全模式，不重新发明）。

`~/.kiro/agents/<name>.json` 的 schema 不由 Bridge 定义——它是 Kiro CLI 的标准格式，Bridge 只做"文件存在性 + 是否为合法 JSON"的校验，不校验内部字段（避免跟 Kiro 版本演进的字段变化绑定，对应非目标里排除"自建可视化表单编辑器"的同一理由）。

## 安全设计（Requirement 3、8.2/8.3 共用）

`GitAssetSource.sync()` 只做本地 clone/pull，不触发任何安装；候选资产列表通过新建的 `buildAssetSyncCard(opts: { source: AssetSourceEntry; candidates: AssetCandidate[] })` 卡片展示，卡片正文固定包含：

- 来源地址（`sourceGitUrl`）+ "内容未经 Bridge_Maintainer 审核"标注（Requirement 3.1）
- 供应链风险提示文案，按 `kind` 分支：
  - `skill`：现有 Requirement 3.2 文案（"可能包含试图诱导执行危险操作的指令"）
  - `agent`：额外一句（Requirement 8.3）——"`prompt` 可能包含试图诱导模型偏离预期职责的指令，`tools`/`mcpServers` 可能授予超出预期范围的工具访问权限"
- 每个候选资产一个"安装"按钮，未点击确认前不写入任何 Kiro 目录（Requirement 3.3）

安装完成后统一走 `GitAssetSource.install()` 内部记录到 `asset-installs.json`（Requirement 3.4）。

## Error Handling

- Git clone/pull 失败（网络、鉴权、仓库不存在）：`sync()` 抛错，`handleSkillCmd`/`handleAgentCmd` 捕获后回 `buildAckCard({ state: 'error' })`，附带 git 的原始 stderr（截断），不吞掉底层原因
- 安装目标已存在同名资产：不视为错误，`install()` 返回 `{ installed: false, reason }`，卡片提示"已存在，未覆盖"而不是报错
- `/agent <name>` 名称不存在：列出当前 `listGlobalAgents()` 的全部名称（Requirement 6.2 已在 Acceptance Criteria 里定义，无需额外设计）
- `~/.kiro/agents/<name>.json` 存在但非合法 JSON：`show`/`set` 时捕获解析错误，该条目在列表中标注"⚠️ 解析失败"而不是让整个命令失败（复用 `dashboard/skills.ts` 里"单个资产解析失败不影响其它"的既有容错原则）

## 已知设计取舍

- **`/model` 现存的池化生效时机问题不在本次修复范围**：核实代码发现 `/model set` 切换后，若目标 chat 的 `AcpPool` entry 仍存活（未被 `/new`/`/cd` 之外的操作 evict），实际不会立刻用新模型——这跟 `/model` 命令自身文案"下一条消息生效"不完全一致，是既有代码里的一个小 bug。本次 `/agent set`/`/agent reset` 主动加了 `acpPool.evict(chatId)` 来避免同样的问题，但不会去改 `/model` 的现有实现（不在本次请求范围内，只是记录发现，供后续单独决定是否修）。
- **Skill 和 Persona 的团队分发共用 `GitAssetSource`，不分别实现**：Requirement 8.1 已明确要求复用 Requirement 2 的机制；两者差异仅在候选资产识别规则和安装目标目录，抽成一个模块比抄两份几乎一样的 clone/确认/安装流程更少代码、更少 bug 面。
- **Persona 创建走表单卡片而非纯文本命令**：飞书文本命令天然不适合输入多行 prompt，复用 `/schedule new` 已验证的表单模式，而不是发明新的交互范式。

## Correctness Properties

### Property 1: 未确认不写入

`GitAssetSource.install()` 只能通过用户在确认卡片上点击"安装"按钮触发；`sync()` 本身绝不写入 `~/.kiro/skills/` 或 `~/.kiro/agents/`。

**Validates: Requirements 3.3**

### Property 2: 不覆盖已存在资产

无论是 Persona_Library 默认安装还是团队 Git 分发安装，目标路径已存在同名资产时 `install()` 必须返回 `installed: false`，绝不覆盖用户已有的自定义内容。

**Validates: Requirements 7.3**

### Property 3: 切换后下一条消息必须生效

`/agent set`/`/agent reset` 必须在写入配置后同步调用 `acpPool.evict(chatId)`，保证下一条消息真正使用新 Agent_Config spawn 子进程，不依赖旧进程恰好被回收。

**Validates: Requirements 6.1**

### Property 4: 安装必留痕

任何通过 `GitAssetSource.install()` 完成的安装都必须写入 `asset-installs.json`，且记录的来源地址与实际 clone 的 `gitUrl` 一致，不允许静默安装。

**Validates: Requirements 3.4**

## Testing Strategy

- `GitAssetSource`：单元测试用临时目录当 fake Git 仓库（`git init` + commit 一个 `SKILL.md` 或 `*.json`），验证 sync 的候选发现、install 的"已存在则跳过"、卸载注意点在于不需要覆盖真实网络 clone
- `runner.ts`/`acp/client.ts` 的 agent 接线：仿照现有 `runner.test.ts`/`client.test.ts` 的 `FakeAcpClient`/mock server 模式，断言 spawn 参数里出现 `--agent <name>`
- `commands/parse.test.ts`：新增 `/skill ...` `/agent ...` 各分支的解析用例，仿照现有 `/model`/`/cron` 用例风格
- `handleAgentCmd`/`handleSkillCmd`：走现有 dispatcher 测试的 mock 模式（若 dispatcher 目前没有单测覆盖这类 handler，走真实运行烟雾测试——起 dispatcher，发命令，断言卡片内容，跟 Web Dashboard 那次验证的模式一致）

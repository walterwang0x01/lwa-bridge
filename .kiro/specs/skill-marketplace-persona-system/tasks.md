# Implementation Plan

## Overview

按 design.md 落地 Skill_Marketplace 和 Persona_System。任务顺序遵循"共享基础设施先行 → 两个方向并行接线 → 内容资产 → 展示层 → 全量验证"：先建通用的 `GitAssetSource`（任务 1-2），再分别接 Skill 和 Persona 的命令层（任务 3-4 与 5-9 相互独立，可并行），最后是内容资产、Dashboard 展示和收尾验证。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "5"] },
    { "id": 1, "tasks": ["2", "6"] },
    { "id": 2, "tasks": ["3", "7"] },
    { "id": 3, "tasks": ["4", "8"] },
    { "id": 4, "tasks": ["9", "10", "11"] },
    { "id": 5, "tasks": ["12"] }
  ]
}
```

说明：任务 1-4（Skill_Marketplace 链路）与任务 5-8（Persona 切换机制链路）在依赖上互不相关，同一 wave 内可并行推进；任务 9（Persona 团队分发）依赖任务 2 的 `GitAssetSource` 和任务 8 的 `handleAgentCmd` 骨架，因此排在两条链路都完成后的 wave 4。

## Tasks

- [x] 1. GitAssetSource 核心模块与持久化
  - 新建 `src/assets/gitSource.ts`：`AssetSourceEntry`/`AssetCandidate`/`AssetInstallRecord` 类型 + `GitAssetSource` 类骨架
  - 新建 `src/assets/store.ts`：`asset-sources.json`/`asset-installs.json` 的读写（zod schema + `proper-lockfile`，模式照抄 `src/store/workspaces.ts` 的 `readFile`/`writeFile`/`withLock`）
  - `src/lib/paths.ts` 新增 `ASSET_SOURCES_FILE`/`ASSET_INSTALLS_FILE`/`ASSET_SOURCES_DIR` 常量，`ensureDataDirs()` 里加对应目录创建
  - 实现 `addSource`/`listSources`/`removeSource`（纯持久化操作，无 git 交互）
  - _Requirements: 2.1, 2.2_

- [x] 2. GitAssetSource 的 sync 与 install
  - 实现 `sync(sourceName)`：用 `execa` 跑 `git clone`（目录不存在）或 `git pull`（已存在）到 `ASSET_SOURCES_DIR/<name>/`，按 `kind` 扫描候选资产（`skill` → 含 `SKILL.md` 的子目录；`agent` → `*.json` 文件），与 `asset-installs.json` 比对标出 `isNew`
  - 实现 `install(sourceName, assetId)`：目标目录/文件已存在同名资产时返回 `{ installed: false, reason }`；否则复制资产并写入 `asset-installs.json`
  - 实现 `listInstalls(kind?)`
  - 单元测试：临时目录 `git init` + commit 一个 `SKILL.md`/`*.json` 模拟远程仓库，覆盖 sync 候选发现、install 的"已存在则跳过"、`asset-installs.json` 落盘正确性
  - _Requirements: 2.1, 2.2, 2.3, 3.3, 3.4, 7.3_

- [x] 3. Skill_Marketplace 命令解析与卡片
  - `src/commands/parse.ts` 新增 `/skill source add|list|rm`、`/skill sync <name>`、`/skill install <name> <assetId>` 分支（`list` 沿用现有无参数 `/skill` 行为，不改动）
  - `src/commands/parse.test.ts` 补齐新分支的解析用例
  - `src/card/builders.ts` 新增 `buildAssetSyncCard(opts)`：展示来源地址 + "内容未经审核"标注 + 供应链风险提示（按 `kind` 分支文案）+ 每个候选资产的"安装"按钮（value 为 `{ action, source, assetId }`）
  - _Requirements: 1.2, 1.3, 3.1, 3.2_

- [x] 4. Skill_Marketplace dispatcher 接线
  - `src/core/dispatcher.ts` 新增 `handleSkillCmd`：`source add/list/rm` 直接调用 `GitAssetSource`；`sync` 调用后用 `buildAssetSyncCard` 展示结果
  - `onCardAction` 新增 `skill.install` 分支，调用 `GitAssetSource.install`，回 `buildAckCard` 展示结果（已安装/已存在跳过/失败）
  - `actionNeedsAdmin()` 加入 `skill.install`（写操作要求 admin，跟现有 `cron`/`conduit` 写操作模式一致）
  - `needAdmin` 命令级判断加入 `source add/rm/sync`（`list` 只读不要求）
  - 真实运行验证：本机建一个临时 git 仓库当 source，走 `/skill source add` → `/skill sync` → 点击安装 → 确认文件落在 `~/.kiro/skills/` 下且 `asset-installs.json` 有记录
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_

- [x] 5. Persona 死字段接线
  - `src/kiro/acp/client.ts`：`AcpClientConfig` 加 `agent?: string`；`spawn()` 里 `if (config.agent) args.push('--agent', config.agent)`
  - `src/kiro/runner.ts`：`runKiro()` 参数解构加入 `agent`；自管模式 `spawnCfg` 加 `if (agent) spawnCfg.agent = agent`
  - `src/core/dispatcher.ts` constructor 的 `new AcpPool({ clientConfig: {...} })` 加入 `agent: this.config.kiro.agent`
  - 单元测试：仿 `src/kiro/runner.test.ts`/`src/kiro/acp/client.test.ts` 现有 mock 模式，断言传入 `agent` 时 spawn 参数里出现 `--agent <name>`，不传时不出现
  - _Requirements: 4.1, 4.2, 5.1_

- [x] 6. Persona 全局资产发现
  - 新建 `src/kiro/agents.ts`：`AgentSummary` 类型 + `listGlobalAgents()`（扫描 `~/.kiro/agents/*.json`，取 `prompt` 字段前 80 字符做 `promptPreview`；单个文件解析失败标注"⚠️ 解析失败"但不影响其它文件，模式照抄 `src/dashboard/skills.ts` 的容错原则）
  - 单元测试：临时目录放合法/非法 JSON 各一个，验证列表结果与容错行为
  - _Requirements: 5.3, 6.3_

- [x] 7. Persona 命令解析与卡片
  - `src/commands/parse.ts`：把 `'agent'` 从 `KIRO_INTERNAL_COMMANDS` 移除；新增 `/agent`（show）、`/agent <name>`（set）、`/agent create <name>`、`/agent reset`、`/agent sync <source>`、`/agent install-defaults` 分支
  - `src/commands/parse.test.ts` 补齐 `/agent` 各分支解析用例
  - `src/card/builders.ts` 新增 `buildAgentPickerCard(opts)`（结构对照 `buildModelPickerCard`：列出全部 Agent_Config + 当前生效项）和 `buildAgentCreateFormCard(opts)`（结构对照 `scheduleCard.ts` 的表单模式：一个 `name` 只读展示 + 一个多行文本输入填 `prompt`，提交 action 为 `agent.createSubmit`）
  - `buildStatusCard` 新增可选参数 `currentAgent`，`/status` 调用处传入 `config.kiro.agent`
  - _Requirements: 5.2, 5.3, 5.4, 6.3, 6.4_

- [x] 8. Persona dispatcher 接线（切换与创建）
  - `src/core/dispatcher.ts` 新增 `handleAgentCmd`：
    - `show` → `listGlobalAgents()` 为空时提示安装默认库；非空用 `buildAgentPickerCard` 展示
    - `set` → 校验目标文件存在（不存在报错+列出可用名称），`patchAndSaveConfig` 写 `config.kiro.agent`，**`await this.acpPool.evict(msg.chatId)`**
    - `reset` → 清除 `config.kiro.agent`，同样 evict
    - `create` → 回 `buildAgentCreateFormCard`
  - `onCardAction` 新增 `agent.set`/`agent.reset`/`agent.createSubmit` 分支（`createSubmit` 写 `~/.kiro/agents/<name>.json`，同名已存在则拒绝并提示手动编辑）
  - `actionNeedsAdmin()` 加入上述新 action；`needAdmin` 命令级判断加入 `agent` 除 `show` 外的所有子命令
  - 真实运行验证：`/agent create test-persona` → 提交表单 → 确认文件落盘 → `/agent test-persona` 切换 → 确认 `config.kiro.agent` 已更新且对应 chat 的 acpPool entry 被 evict
  - _Requirements: 4.3, 4.4, 5.2, 5.4, 6.1, 6.2, 6.4_

- [x] 9. Persona 团队分发接线
  - `src/core/dispatcher.ts` 的 `handleAgentCmd` 新增 `sync` 分支，复用 `GitAssetSource`（`kind='agent'`）+ `buildAssetSyncCard`
  - `onCardAction` 新增 `agent.install` 分支，调用 `GitAssetSource.install`
  - `actionNeedsAdmin()`/`needAdmin` 加入 `agent sync`/`agent.install`
  - 真实运行验证：临时 git 仓库放一个 Agent_Config JSON，走 `/agent sync` → 确认卡片文案包含 Requirement 8.3 的额外风险提示 → 安装后文件落在 `~/.kiro/agents/`
  - _Requirements: 8.1, 8.2, 8.3_

- [x] 10. Persona_Library 默认角色内容资产
  - 新建 `src/kiro/personaLibrary/customer-service.json` 和 `code-reviewer.json`（各含 `prompt` + 匹配职责的 `tools` 白名单）
  - 新建 `src/kiro/personaLibrary/index.ts`：`listPersonaLibrary()` 读取上述文件
  - `handleAgentCmd` 的 `install-defaults` 分支：逐个用 `GitAssetSource` 同款"已存在则跳过"逻辑写入 `~/.kiro/agents/`，`buildAckCard` 汇总"已安装 N 个，跳过 M 个已存在的"
  - `package.json` 的 `files` 字段加入 `dist/kiro/personaLibrary/**/*.json`
  - _Requirements: 7.1, 7.2, 7.4_

- [x] 11. Dashboard 扩展
  - `src/dashboard/server.ts` 的 `buildOverview()` 新增 `agents: listGlobalAgents()` 和 `assetInstalls: gitAssetSource.listInstalls()`
  - `dashboard-ui` 前端加一个 Agents 面板（结构对照现有 Skills 面板）
  - 真实运行验证：起 dashboard，curl `/api/overview`，确认新字段存在且内容正确
  - _Requirements: 5.3_

- [x] 12. 全量验证与文档
  - 跑 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`，全部通过
  - `docs/ARCHITECTURE.md` 补充 Skill_Marketplace / Persona_System 的架构说明（参照现有 conduit 章节的写法）
  - `README.md`/`README.en.md` 补充 `/skill source`/`/agent` 命令的用法说明
  - _Requirements: 全部_

## Notes

- 每个任务完成后都建议跑一次 `pnpm typecheck && pnpm lint`，不要攒到任务 12 才发现大范围类型错误
- 涉及"真实运行验证"的任务，验证完成后要清理临时创建的 git 仓库和测试用 Agent_Config 文件，不留垃圾数据在 `~/.kiro/` 或 `~/.lark-kiro-bridge/` 下

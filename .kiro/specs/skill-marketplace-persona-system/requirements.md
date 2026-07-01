# Requirements Document

## Introduction

Lark_Kiro_Bridge 是单人维护的开源项目（npm 包 `lark-kiro-bridge`），把 Kiro CLI 接到飞书。本次评估的触发点是参照腾讯云 WorkBuddy（商业级 AI 办公助手，背后有 OpenClaw/ClawHub 生态、13,700+ 技能市场、上百个预设角色、独立桌面 GUI、企业级团队协作）提出的两个方向：

1. **Skill_Marketplace**：类似 ClawHub，让用户发现/安装/分享可复用的 Skill，而不是全靠用户自己写 SKILL.md 放进 `~/.kiro/skills/`
2. **Persona_System**：类似 WorkBuddy 的"数字员工"，预设一组角色（system prompt + Skill/工具组合），用户按角色切换交互风格/专长领域

Bridge_Maintainer 明确要求：**先评估投入产出，再决定做不做、做多大**，不能因为 WorkBuddy 有某功能就直接照抄全部规模。

**本文档是对同名旧草稿的重新评估，并推翻了旧草稿中 Persona_System 部分的核心结论**——推翻依据见下方"本次重新评估的关键变化"。Skill_Marketplace 部分的结论沿用旧草稿（已验证成立，未发现新证据推翻它）。

Bridge_Maintainer 已就目标用户范围、技术路径、Persona_System 定位等关键问题给出明确答案（见文末"已确认决策"），本文档的交付目标是：

- 把 Skill_Marketplace 和 Persona_System 分别要解决的具体问题讲清楚，并按已确认的目标用户范围（他人及团队）定义需求
- 把已确认的技术路径（复用 Git 生态）落实到具体 Requirement 里
- 把安全边界（第三方 Skill / Agent_Config 供应链风险）作为跨方向的强制约束提出来
- 明确排除哪些 WorkBuddy 才有意义、但对单人维护的开源项目仍不合理的功能（如企业级多租户、大规模内容审核团队）

### 本次重新评估的关键变化（推翻旧草稿的依据）

旧草稿把 Persona_System 当作"当前不存在、需要从零设计"的新能力来评估（Requirement 4/5/6 都在讨论"要不要建"）。经过对 Kiro CLI 和 Bridge 现有代码的核实，**这个前提是错的**——跟 Skill_Marketplace 的情况高度相似：

- **Kiro CLI 原生支持 Agent 机制**：`kiro-cli acp --agent <AGENT>` 是官方参数（`kiro-cli acp --help` 已确认），`~/.kiro/agents/<name>.json` 是标准配置文件，字段包含 `prompt`（system prompt）、`tools`（工具白名单）、`mcpServers`、`model`——这正是 Persona 想要的"system prompt + 工具集合"组合，且已经是 Kiro 官方定义的标准格式，不是 Bridge 要自己发明的概念
- **Bridge 代码里已经声明了 agent 字段，但从未真正接线**：`src/lib/config.ts` 的 `kiro.agent`、`src/kiro/runner.ts` 的 `RunOptions.agent` 都存在，但 `runner.ts` 里 `runKiro()` 函数体的参数解构根本没取出 `agent` 字段，注释写"保留以维持契约"——这是一个存在了但被遗忘的死字段，说明"按 agent 切换"这条路径此前已经被规划过，只是没做完
- **`/agent` 命令目前被当作"不支持"直接拦截**：`src/commands/parse.ts` 把 `/agent` 归入 `KIRO_INTERNAL_COMMANDS`，用户发 `/agent` 会收到"这个命令只在终端跑 kiro-cli 时可用，桥接器无法代理"的提示——但既然 `--agent` 是 ACP 子进程的启动参数，桥接器完全有能力代理它，只是没实现
- **本机没有任何真实 agent 配置在用**：`~/.kiro/agents/` 下只有一个 `agent_config.json.example`，说明这条路径连 Bridge_Maintainer 自己都没手动用过，不存在"已经用得很顺、只是没暴露到飞书"的情况——这是一块完全空白、待评估是否值得填的能力，不是已验证好用只差临门一脚的能力

**结论**：Persona_System 底层机制不是"要不要新建一个系统"，而是"要不要把 Kiro 已有的 Agent 机制接进飞书交互"。这跟 Skill_Marketplace 的结论结构一致（Skill 本身已有原生支持，Bridge 只需要决定要不要加发现/安装/切换的交互层），因此本文档把两者放在同一份需求里，用统一的评估框架处理。

**Bridge_Maintainer 已确认决策**：两个方向的目标用户都扩展到其他用户及团队，且 Persona_System 要做成完整产品——不只接线切换机制，还要提供一套默认角色内容资产（角色库）并支持团队分发。这个决策已写入下方对应 Requirement，文档末尾的"已确认决策"记录留存决策依据。

**已知现状**（避免重复调研或提出与现状冲突的需求）：

- Kiro CLI 原生支持 `~/.kiro/skills/<name>/SKILL.md`（YAML frontmatter + markdown 指令），格式与 Anthropic Agent Skills / OpenClaw 兼容
- Bridge_Maintainer 本机已有 30+ 个 Skill（来源 `github.com/addyosmani/agent-skills`）
- `docs/SKILL_REGISTRY_PROPOSAL.md` 已推翻"自建 Skill Registry + 自定义 trigger/verify 字段"方案，结论是 Kiro 原生已支持 Skill，重复造轮子不可取——本文档延续该结论，不重新论证
- Dashboard（本机 `127.0.0.1:5180`，Vue 3，只读）已实现 `listGlobalSkills()`，展示 `~/.kiro/skills/` 下所有 Skill 的 name + description，这部分能力已经存在
- Kiro CLI 原生支持 `~/.kiro/agents/<name>.json`（Agent 配置：`prompt` + `tools` + `mcpServers` + `model`），本机目前只有示例文件、无真实配置在用
- Bridge 代码已有 `kiro.agent` 配置字段和 `RunOptions.agent` 参数，均已声明但未接线（`runKiro()` 未使用该字段拼进 ACP 启动参数）
- Bridge 已有 `/steering`（管理 Kiro 指令文件）、`/cron`（定时任务）、`/conduit`（串联 kiro-conduit 多 agent 编排器）等飞书内命令，均遵循"飞书命令 → 卡片确认 → 落地文件系统"的统一模式
- `/model` 命令已有完整实现（`handleModelCmd` + `model.set`/`model.reset` card action），采用"全局配置覆盖，下一条消息生效"的模式，是本文档评估 Persona 切换命令时的参照对象
- 安全模型：`kiro.trustedTools` 白名单控制 Kiro 能调用的工具；三层访问控制（用户/群/管理员白名单）
- ClawHub（WorkBuddy 依托的第三方公开 Skill 生态，13,700+ Skill）2026 年 2 月被 VirusTotal 扫出过几百个恶意 Skill，供应链安全是已发生的真实风险

## Glossary

- **Bridge**：lark-kiro-bridge 现有系统（飞书 ↔ Kiro CLI 桥接）
- **Bridge_Maintainer**：Bridge 的开发维护者，当前为单人
- **Bridge_User**：安装并使用 Bridge 的人，可能是 Bridge_Maintainer 本人，也可能是其他人
- **Skill**：Kiro CLI 原生识别的能力单元，定义在 `<name>/SKILL.md`（YAML frontmatter + markdown 指令）
- **Skill_Marketplace**：本次评估的候选新能力——让 Bridge_User 发现、安装、分享 Skill 的机制（当前不存在）
- **Skill_Source**：Skill 的托管来源，例如公开 Git 仓库地址或第三方公开 Registry
- **Untrusted_Skill**：来自 Skill_Source 且未经 Bridge_User 本人审查确认的 Skill
- **Agent_Config**：Kiro CLI 原生识别的 Agent 配置单元，定义在 `~/.kiro/agents/<name>.json`（`prompt` + `tools` + `mcpServers` + `model`）
- **Persona**：本文档中特指"通过 Bridge 飞书内命令可切换的 Agent_Config"。切换机制复用 Kiro 原生 Agent_Config 格式，不新增私有字段；但 Persona_System 额外维护一套默认内容资产（见 Requirement 7），这部分内容资产由 Bridge 提供和维护
- **Persona_System**：本次确认要做的完整产品，包含两部分：(1) 把已有 Kiro Agent_Config 机制接入飞书交互的切换机制；(2) 一套默认角色内容资产及团队分发能力（当前均缺失）
- **Persona_Library**：Persona_System 提供的默认角色内容资产集合（见 Requirement 7）
- **Dashboard**：Bridge 现有的本机只读 Web 控制台（`127.0.0.1:5180`）
- **Full_Scope**：Persona_System 已确认的落地规模基线——切换机制 + Persona_Library + 团队分发，非可选项

## Requirements

### Requirement 1: Skill_Marketplace 的问题定义与目标用户边界（已确认：扩展到他人及团队）

**User Story:** 作为 Bridge_Maintainer，我想让其他 Bridge_User 甚至团队都能发现和复用彼此的 Skill，而不是每个人各自维护一份。

#### Acceptance Criteria

1. THE Skill_Marketplace SHALL 将核心问题限定为"Bridge_User 之间发现和复用彼此的 Skill"，区别于"从零编写 Skill"（该问题已由 Kiro 原生 `lark-skill-maker` Skill 覆盖）
2. THE Skill_Marketplace SHALL 支持从 Bridge_Maintainer 或团队指定的 Skill_Source 发现和安装 Skill，目标用户不限于 Bridge_Maintainer 本人
3. THE Skill_Marketplace SHALL 支持团队场景：团队内多个 Bridge_User 共享同一个 Skill_Source，新增或更新的 Skill 可被团队成员同步获取

### Requirement 2: Skill_Marketplace 的技术路径（已确认：复用现有生态）

**User Story:** 作为 Bridge_Maintainer，我想用最低维护成本的方式实现 Skill 分发，不承担中心化 Registry 的托管和审核责任。

#### Acceptance Criteria

1. THE Skill_Marketplace SHALL 将 Skill_Source 限定为 Git 仓库地址（可以是公开仓库，也可以是团队私有仓库），并复用 SKILL.md 已有的标准格式，不新增私有元数据字段
2. THE Skill_Marketplace SHALL 通过 `git clone` 或 `git pull` 将 Skill_Source 中的 Skill 目录同步到本机 `~/.kiro/skills/`，不维护独立的索引服务
3. THE Skill_Marketplace SHALL 支持团队场景下的私有 Git 仓库作为 Skill_Source，访问权限完全委托给 Git 仓库自身的权限控制，Bridge 不重复实现账号或权限体系

### Requirement 3: 第三方 Skill 安装的安全边界（跨规模强制约束）

**User Story:** 作为 Bridge_User，我想在安装他人分享的 Skill 前看到清晰的风险提示并主动确认，以避免重复 ClawHub 已发生过的供应链安全事件。

#### Acceptance Criteria

1. WHEN Bridge_User 触发从 Skill_Source 安装一个 Untrusted_Skill, THE Skill_Marketplace SHALL 在写入 `~/.kiro/skills/` 之前展示该 Skill 的来源地址，并标注"内容未经 Bridge_Maintainer 审核"
2. WHEN Bridge_User 触发从 Skill_Source 安装一个 Untrusted_Skill, THE Skill_Marketplace SHALL 在确认卡片中包含供应链风险提示，说明第三方 Skill 可能包含试图诱导执行危险操作的指令
3. IF Bridge_User 未在安装确认卡片上明确确认, THEN THE Skill_Marketplace SHALL 不将该 Skill 写入 `~/.kiro/skills/`
4. WHEN 一个 Skill 安装完成, THE Skill_Marketplace SHALL 记录该 Skill 的来源地址和安装时间，并在 Dashboard 展示

### Requirement 4: Persona_System 的问题定义与目标用户边界（已推翻旧结论：确认做完整产品）

**User Story:** 作为 Bridge_Maintainer，我想明确 Persona_System 作为完整产品包含哪些部分，以便按正确规模规划实现。

#### Acceptance Criteria

1. THE Persona_System SHALL 包含两部分：切换机制（把 Kiro CLI 已有的 Agent_Config 机制接入飞书内交互）与内容资产（Persona_Library，见 Requirement 7）
2. THE Persona_System 的切换机制部分 SHALL 复用 Agent_Config 已有的字段边界（`prompt` / `tools` / `mcpServers` / `model`），不新增 Bridge 私有的角色元数据字段
3. THE Persona_System SHALL 将"按场景切换 system prompt 与工具集合"的问题与"多角色协同编排"（已由现有 `/conduit` 命令覆盖）区分开，本文档只评估前者
4. THE Persona_System 的目标用户 SHALL 不限于 Bridge_Maintainer 本人，覆盖其他 Bridge_User 及团队场景

### Requirement 5: Persona_System 的落地形态（已确认：Full_Scope 为基线）

**User Story:** 作为 Bridge_User，我想在飞书里直接发现和切换可用的 Persona，不需要自己去编辑服务器上的 JSON 文件。

#### Acceptance Criteria

1. THE Persona_System SHALL 将 `RunOptions.agent` 和 `config.kiro.agent` 这两个已声明但未接线的字段接通——在 `runKiro()` 内把 `agent` 值拼进 ACP 子进程的 `--agent` 启动参数
2. THE Persona_System SHALL 提供飞书内 `/agent` 命令（复用现有 `/model` 命令的实现模式：全局配置覆盖 + 卡片确认 + 下一条消息生效），支持列出 `~/.kiro/agents/` 下的可用 Agent_Config 并切换
3. THE Persona_System SHALL 在 Dashboard 增加一个只读列表，展示 `~/.kiro/agents/` 下已发现的 Agent_Config 名称与描述（复用 Dashboard 现有 `listGlobalSkills()` 的实现模式）
4. THE Persona_System SHALL 支持通过飞书命令创建/编辑简单的 Agent_Config（至少 `prompt` 字段），不强制要求 Bridge_User 手动登录服务器编辑 JSON 文件——但复杂字段（`tools` / `mcpServers`）仍建议直接编辑文件，避免飞书侧重复实现完整表单校验

### Requirement 6: Persona 的运行时切换行为

**User Story:** 作为 Bridge_User，我想在飞书里按需切换当前会话使用的 Agent_Config，以便让 Kiro 用对应的 system prompt 和工具范围响应我。

#### Acceptance Criteria

1. WHEN Bridge_User 执行 `/agent <name>`, THE Persona_System SHALL 将 `config.kiro.agent` 更新为该名称并落盘，后续 `runKiro()` 调用将其拼入 ACP 子进程的 `--agent` 参数
2. IF Bridge_User 指定的 Agent_Config 名称在 `~/.kiro/agents/` 下不存在对应的 `<name>.json` 文件, THEN THE Persona_System SHALL 返回错误提示并列出当前已发现的 Agent_Config 名称
3. WHEN Bridge_User 执行 `/agent`（不带参数）, THE Persona_System SHALL 列出 `~/.kiro/agents/` 下所有可用 Agent_Config 及当前生效的 Agent_Config 名称
4. WHEN Agent_Config 切换生效, THE Persona_System SHALL 在 `/status` 命令的输出中显示当前生效的 Agent_Config 名称（若未设置则显示 Kiro 默认 agent）

### Requirement 7: Persona_Library 默认角色内容资产（新增）

**User Story:** 作为 Bridge_User，我想安装 Bridge 后就有一批现成可用的角色，而不必自己从零编写 Agent_Config 的 prompt 内容。

#### Acceptance Criteria

1. THE Persona_System SHALL 随包提供一组默认 Agent_Config（Persona_Library），首批覆盖至少两类场景：通用问答/客服类、代码审查类
2. THE Persona_Library 中每个默认 Agent_Config SHALL 包含清晰的 `prompt`（角色职责与边界）和与职责匹配的 `tools` 白名单，不使用宽泛无限制的工具集合
3. WHEN Bridge 首次启动或 Bridge_User 主动触发安装, THE Persona_System SHALL 将 Persona_Library 中的默认 Agent_Config 写入 `~/.kiro/agents/`，不覆盖 Bridge_User 已存在的同名自定义 Agent_Config
4. THE Persona_Library 的内容资产 SHALL 作为 Bridge 代码仓库的一部分维护和版本管理，随 Bridge 版本发布更新

### Requirement 8: Persona 团队分发（新增）

**User Story:** 作为团队里的 Bridge_Maintainer，我想让团队自定义的 Persona 能像 Skill 一样通过 Git 仓库分发给团队成员，不需要每个人手工复制 JSON 文件。

#### Acceptance Criteria

1. THE Persona_System SHALL 复用 Requirement 2 已确认的 Skill 分发机制（Git 仓库 + `git clone`/`pull`），将团队自定义 Agent_Config 同步到 `~/.kiro/agents/`
2. WHEN Bridge_User 从团队指定的 Persona_Source（Git 仓库）安装一个未经 Bridge_Maintainer 审核的 Agent_Config, THE Persona_System SHALL 套用 Requirement 3 已定义的安全确认流程——展示来源地址、供应链风险提示，且未确认不写入
3. THE Persona_System SHALL 将 Requirement 3 的风险提示扩展到 Agent_Config 场景：额外说明 `prompt` 可能包含试图诱导模型偏离预期职责的指令，`tools`/`mcpServers` 可能授予超出预期范围的工具访问权限

## 非目标（Out of Scope）

以下能力在 WorkBuddy 的商业产品语境下有意义，但对单人维护的开源项目 Bridge 不成立，本次评估明确排除：

- **独立桌面 GUI 应用**：Bridge 的产品形态是"飞书内命令 + 本机只读 Dashboard"，不新增第二套客户端界面
- **企业级多租户 / 组织管理**：Bridge 当前无商业化团队支撑多租户运维、计费、权限分级等企业级能力
- **大规模 Skill 内容审核团队**：13,700+ Skill 规模的 ClawHub 依托专门的内容审核体系，单人维护项目不具备对应运营资源
- **Bridge 自建 Agent_Config 可视化表单编辑器（复杂字段）**：`tools`/`mcpServers` 等复杂字段仍要求直接编辑 JSON 文件，Bridge 只在飞书侧支持创建/编辑简单场景（见 Requirement 5.4），不做完整表单校验系统
- **自建中心化 Skill/Persona Registry**：已在 Requirement 2 确认选择复用 Git 生态，不建索引服务
- **因为 WorkBuddy 有对应功能就默认要做**：本次评估仅围绕 Bridge_Maintainer 明确点名的两块能力展开，不做功能对齐式的扩张

## 已确认决策

Bridge_Maintainer 已对以下问题给出明确答案，决策已落入上方对应 Requirement，不再作为待决策问题：

1. **Skill_Marketplace 目标用户**：扩展到其他 Bridge_User 及团队（非仅自用）→ 对应 Requirement 1
2. **Skill_Marketplace 技术路径**：选择"复用现有生态"（Git 仓库 + `git clone`/`pull`），不自建中心化 Registry → 对应 Requirement 2
3. **Persona_System 定位**：Bridge_Maintainer 明确要求做完整产品（切换机制 + 默认角色内容资产），而非仅接通死字段的最小机制 → 对应 Requirement 4、7
4. **Persona_System 落地形态**：Full_Scope 为基线（`/agent` 命令 + Dashboard 只读列表 + 简单场景飞书内创建/编辑），并新增团队分发能力 → 对应 Requirement 5、6、8

# Skill 与 conduit 串联：现状核实与真实差距

> 更新时间：2026-06-30
> 状态：本文档已修正。早先版本提议"自建 Skill Registry"，经本机核实后确认是重复造轮子，已废弃该方案。

---

## 0. 修正说明（为什么推翻前一版）

前一版方案提议在 lark-kiro-bridge 里自建一套 Skill Registry（`src/skills/store.ts`
+ 自定义 `trigger`/`verify` 字段 + prompt 注入）。**这是错的**，原因：

1. **Kiro CLI 原生就支持 skill**——无需 bridge 介入
2. **本机已有成熟 skill 库**——要"建"的东西已经存在
3. **自创字段会脱离标准**——`trigger`/`verify` 是私有发明，不可迁移

下面是本机核实（kiro-cli 2.10.0，macOS）的事实。

---

## 1. 已验证事实：Kiro 原生 skill 机制

### 加载位置

```
~/.kiro/skills/<skill-name>/SKILL.md      ← 全局，Kiro 启动自动加载
```

本机 `~/.kiro/skills/` 下已有 30+ skill（多数 symlink 到 `~/.agents/skills/`），
来源是 `github.com/addyosmani/agent-skills`（Addy Osmani，Chrome 团队）。

### 标准格式（与 Anthropic Agent Skills / OpenClaw 一致）

```markdown
---
name: lark-calendar
version: 1.0.0
description: "飞书日历：管理日历日程和会议室……当用户需要……时使用。不负责：……"
metadata:
  requires:
    bins: ["lark-cli"]
  cliHelp: "lark-cli calendar --help"
---

# calendar (v4)

正文：意图路由、约束、API 清单……

references/                              ← 渐进式加载：用到才读的细节文档
  lark-calendar-create.md
  lark-calendar-agenda.md
  ...
```

要点：
- `description` 同时承担"何时用 / 何时不用"的路由职责（Kiro 据此选 skill）
- `metadata.requires.bins` 声明依赖（标准字段，不是自创）
- `references/` 子目录做渐进式披露——主 SKILL.md 精简，细节按需加载

### 已有的相关 skill（覆盖此前提议的全部场景）

| skill | 覆盖场景 |
|-------|---------|
| `lark-calendar` | 日程增删查改、会议室预定 |
| `lark-minutes` | 会议纪要 |
| `lark-vc` | 视频会议记录 |
| `lark-workflow-meeting-summary` | 会议总结工作流 |
| `lark-workflow-standup-report` | 站会报告工作流 |
| `lark-skill-maker` | 创建新 skill 的 skill |

### 连"可验证交付"都已内置

`lark-calendar/SKILL.md` 原文已包含：
> 删除/修改后验证：等待 2 秒再查询（API 最终一致性）

即此前提议要新增的 `verify` 机制，标准 skill 用自然语言指令已经表达了。

---

## 2. lark-kiro-bridge 的真实差距（几乎为零）

因为 Kiro 跑起来就自动用这些 skill，bridge 跑 `kiro-cli acp` 时**能力层已经生效**，
不需要 bridge 做任何 skill 注入。

真实可选的小改进（非必须）：

| 改进 | 价值 | 工作量 | 是否建议 |
|------|------|--------|---------|
| 飞书加 `/skill list` 列出可用 skill | 可视化，知道有哪些能力 | 小（复用 `/steering` 卡片） | 可选，体感提升 |
| `/skill view <name>` 看 skill 内容 | 调试/学习 | 小 | 可选 |
| 新建/编辑 skill 的飞书表单 | 飞书内造 skill | 中 | **不建议**——已有 `lark-skill-maker`，让 Kiro 自己造 |

结论：**不要自建 registry / 注入 / 自定义字段**。最多加只读的 `/skill list` 提升可见性。

---

## 3. conduit 串联方式（已验证）

### 核心结论

lark-kiro-bridge 串联外部工具的统一模式 = **spawn 子进程**（它就是这样调
`kiro-cli` 和 `lark-cli` 的）。conduit 要被串联，唯一要求是 `lwa-conduit`
命令在 PATH 上。

`lwa-conduit/pyproject.toml` 已配好入口（已验证）：

```toml
[project.scripts]
lwa-conduit = "kiro_conduit.cli:main"
```

### 上 PATH 的方式（按推荐度）

| 方式 | 命令 | 适合 |
|------|------|------|
| pipx（本地/git） | `pipx install <path-or-git>` | 个人自用最稳，隔离环境 |
| uv tool | `uv tool install ...` | 同上，更快 |
| PyPI | `pip install lwa-conduit` | 公开分发给别人 |

### 关于发 PyPI

- **发不发 PyPI 与"能否串联"无关**——串联靠 PATH + 子进程
- 自用：先 `pipx install`，不必急着发
- 要发：conduit 现为 `0.0.1 Pre-Alpha`，应发 alpha 版（如 `0.1.0a1`）并明确标注，不要让人误以为生产可用

### 串联落地（待做，非本次）

bridge 加 `/conduit run <spec>` 命令：
1. spawn `lwa-conduit run <spec>` 子进程（同 kiro-cli 的 spawn 模式）
2. 解析其输出/事件
3. 进度推回飞书卡片（复用现有 RunState 卡片体系）

**建议**：等 skill 现状确认无需改动后再做这条连接线，一次只动一处。

---

## 4. 一句话总结

- **Skill**：Kiro 原生支持 + 你已有成熟库，**几乎不用做**，最多加 `/skill list`
- **conduit 串联**：靠 PATH + spawn 子进程，**先 pipx 自用**，PyPI 非必须
- **不要做**：自建 skill registry、自定义 skill 格式、prompt 注入层

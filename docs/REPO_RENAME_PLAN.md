# 阶段 B：仓库与包名重命名规划

> **状态：B1 部分已执行（2026-07-10）** — CLI 主命令改为 `lwa`，数据目录 `~/.lwa`（自动迁移）；npm 包名仍为 `lark-kiro-bridge`；PyPI `kiro-conduit` 未改。
>
> 全量 B1（包名 + CLI 改名）仍待决策，见文末决策门。

## 当前状态（方案 A，已落地）

| 层级 | 名称 | 是否已改 |
|------|------|----------|
| 体系品牌 | **LWA**（Lark Local Agent Workbench） | ✅ 文档 / README / GitHub 描述 |
| 产品名 | **Bridge** / **Conduit** | ✅ 对外话术 |
| GitHub 仓库 | `lwa-bridge` / `lwa-conduit`（原 `lark-kiro-bridge` / `kiro-conduit` 重定向） | ✅ B3 已改 |
| npm 包 | `lark-kiro-bridge` | ❌ 未改 |
| PyPI 包 | `kiro-conduit` | ❌ 未改 |
| CLI 命令 | `lark-kiro-bridge` / `kiro-conduit` | ❌ 未改 |
| 代码标识符 | 同上 | ❌ 未改 |

原则：**对外讲 LWA，对内继续用稳定技术名**，避免用户升级踩坑。

## 阶段 B 会动什么

若进入阶段 B，典型变更范围：

| 对象 | 示例候选 | 影响 |
|------|----------|------|
| GitHub 仓库 | `lwa-bridge` / `lwa-conduit` | URL、clone、CI、外链需更新或重定向 |
| npm 包名 | `lwa-bridge` 或 scoped `@lwa/bridge` | **breaking**：`npm install` 命令变化 |
| PyPI 包名 | `lwa-conduit` | **breaking**：`pip install` 命令变化 |
| CLI 二进制名 | 可保留旧名作 alias，或双轨一段时间 | 用户脚本、systemd、飞书文档 |
| 配置目录 | `~/.lark-kiro-bridge/` | 需迁移或兼容读取 |
| Python 模块 | `kiro_conduit` | 改动面大，建议**最后**或保留 |

## 候选命名方案（待你拍板）

### 方案 B1：LWA 前缀（与体系名一致）

| 现名 | 候选 |
|------|------|
| `lark-kiro-bridge` | `lwa-bridge` |
| `kiro-conduit` | `lwa-conduit` |

优点：与 LWA 品牌一致；缺点：npm/PyPI 上 `lwa-*` 可能被占，需先查重。

### 方案 B2：保留语义前缀（渐进）

| 现名 | 候选 |
|------|------|
| `lark-kiro-bridge` | `lark-agent-bridge` |
| `kiro-conduit` | `agent-conduit` |

优点：脱离单一 CLI 绑定；缺点：与 LWA 简称关联弱。

### 方案 B3：仅 GitHub 改名，包名不动

只改 GitHub 仓库显示名 / 重定向，**npm/PyPI/CLI 保持现状**。

优点：零用户 breaking change；缺点：品牌与技术名长期分裂。

**推荐默认**：B3 已执行；观察 1–2 个 release 周期后，再决定是否做 B1 全量迁移（npm/PyPI/CLI）。

## 迁移检查清单（执行时用）

### 准备

- [ ] 在 npm / PyPI 注册新包名（或确认 scoped 策略）
- [ ] 统计下游引用：README 外链、Bridge `/conduit` 文档、`KIRO_CONDUIT_BIN` 用户
- [ ] 定 **deprecation 窗口**（建议 ≥ 3 个月双轨）

### GitHub

- [ ] `Settings → Rename` 仓库（GitHub 自动保留 redirect）
- [ ] 更新两个仓库互链、PITCH、npm `repository` URL
- [ ] 更新 CI badge、Actions secret 若绑路径

### npm（Bridge）

- [ ] 新包发布 + README 顶部 deprecation 说明
- [ ] 旧包 `deprecated` 字段指向新包
- [ ] 可选：`lark-kiro-bridge` 发一个薄 wrapper 版本仅 re-export（降低断裂感）

### PyPI（Conduit）

- [ ] 新包 `lwa-conduit`（或选定名）首发
- [ ] 旧包 README / PyPI 描述指向新包
- [ ] `kiro-conduit` CLI 保留为 entry point alias（若技术上可行）

### 用户数据

- [ ] `~/.lark-kiro-bridge/` → 新目录或 symlink 策略
- [ ] 配置 schema 版本字段 + 自动迁移脚本
- [ ] 文档：升级指南单独一页

### 验证

- [ ] 全新机器：`npm i` / `pipx i` 走新名可跑通
- [ ] 旧机器：旧命令仍可用或给出明确迁移提示
- [ ] Bridge `/conduit` 默认 PATH 探测仍工作

## 不建议现在做的原因

1. **npm 已有下载与用户** — `lark-kiro-bridge` 在 registry 有历史
2. **CLI 已写进用户 muscle memory** — 飞书文档、cron、launchd 难一次性改完
3. **Conduit 仍 Pre-Alpha** — 包名变更成本相对低，但应与 Bridge 同一叙事一起改
4. **品牌尚未对外大规模传播** — 先让 LWA 话术跑稳，再动技术名更划算

## 决策门

进入阶段 B 前请确认：

1. **选定方案**：B1 / B2 / B3（或自定义）
2. **是否接受 breaking change**：是 / 否（否 → 仅 B3）
3. **deprecation 时长**：建议 90 天
4. **谁执行发布**：npm / PyPI 账号与 changeset 流程

确认后可在 Issue 中跟踪，按清单逐项 PR。

## 相关文档

- [PITCH.md](./PITCH.md) — 对外介绍（方案 A）
- [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) — 体系总览
- Conduit 侧镜像：[lwa-conduit/docs/REPO_RENAME_PLAN.md](https://github.com/walterwang0x01/lwa-conduit/blob/main/docs/REPO_RENAME_PLAN.md)

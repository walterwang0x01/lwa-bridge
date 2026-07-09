# Spike：CLI 配额探测与 Fallback（设计草案）

> 状态：**设计 only**（2026 Q3）— 实现见 [ROADMAP-LWA.md](./ROADMAP-LWA.md) 2026 Q4。
>
> 政策与额度以各厂商**官方文档为准**；接入前必须再核实。

## 目标

在路由前回答三个问题：

1. 这个 runtime **还有没有额度**？
2. 额度**够不够**完成当前 bucket 的典型任务？
3. 若没有，**按什么顺序** fallback 到下一个 runtime？

## 建议接口（Bridge / Conduit 共用契约）

```typescript
interface QuotaStatus {
  runtimeKind: string;
  /** healthy | depleted | unknown | error */
  state: 'healthy' | 'depleted' | 'unknown' | 'error';
  /** 0–1，未知时为 undefined */
  remainingRatio?: number;
  /** 人类可读，用于 /status 与日志 */
  detail?: string;
  checkedAt: string; // ISO8601
}

interface QuotaProbe {
  probe(profile: RuntimeProfile): Promise<QuotaStatus>;
}
```

- 结果缓存 **5–15 分钟**（可配置），避免每次 turn 都打厂商 API
- `unknown` 时不阻断路由，但 metrics 记 `quota_unknown`
- `depleted` 时从候选列表剔除，直到下次 probe 恢复

## 各 CLI 探测方式（2026-07 调研）

| Runtime | 探测来源 | 可信度 | Fallback 建议 |
|---------|----------|--------|---------------|
| `kiro-cli-acp` | `kiro-cli` 账户/usage 子命令或官方 usage API（需查最新 CLI） | 中 | → `cursor-agent-cli` 或 `gemini-cli` |
| `cursor-agent-cli` | 暂无稳定 CLI quota；可从 `result.usage` 累积 + 订阅档位配置 | 低 | → `gemini-cli` |
| `gemini-cli` | OAuth 账号配额 / API key tier（见 [gemini-cli quota 文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md)） | 中–高 | → `cursor-agent-cli` |

## Fallback 链（默认提案）

按 **task bucket** 可配置，全局默认：

```
chat / edit (simple)     : cursor → gemini → kiro
plan / review / conduit  : kiro → gemini → cursor（不优先 cursor）
implementor (conduit)    : cursor → gemini → kiro
```

reviewer **永不**因省钱 fallback 到弱模型，除非用户显式配置。

## 与 adaptive 的关系

1. **Quota** 是硬约束：depleted 直接剔除
2. **Adaptive** 是软优化：在剩余候选中选 score 最高
3. 两者正交：先 filter，再 recommend

## 验收（Q4 实现时）

- [ ] 模拟 Kiro depleted，chat 自动切 Cursor，日志含 `quota_fallback`
- [ ] Dashboard / `report` 展示各 runtime 最近 probe 状态
- [ ] 单元测试：depleted + 全 depleted 时的错误提示友好

## 开放问题

- [ ] Cursor 是否有官方 quota API？若无，是否只做「累计 token 达用户配置上限」？
- [ ] Gemini 免费档政策是否稳定？需 feature flag `runtime.gemini.enabled`
- [ ] 是否按**自然月**还是**滚动 30 天**重置用户本地计数？

Track: Bridge repo label `roadmap-q4` · 实现 PR 需同步 Conduit `model_router.py`

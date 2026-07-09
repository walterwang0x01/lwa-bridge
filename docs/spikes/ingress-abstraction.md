# Spike：Ingress 抽象（Q4 第一步）

> 状态：**已落地骨架（2026-07）** — 飞书经 `ingress/lark` 适配；`ingress/mock` 可跑无凭据测试。

## 目标

让 `core/dispatcher` 只认渠道无关类型，换 IM 不换编排内核。

```
渠道 SDK ──► ingress/<channel> ──► NormalizedMessage
                                      │
                                      ▼
                               core/dispatcher
                                      │
                                      ▼
                               IngressPort（出站）
```

## 已实现

| 模块 | 路径 | 说明 |
|------|------|------|
| 类型 | `src/ingress/types.ts` | `NormalizedMessage`, `NormalizedCardAction`, `IngressPort` |
| 注册表 | `src/ingress/registry.ts` | `registerIngressChannel` / `getIngressChannel` |
| 飞书 | `src/ingress/lark/` | `normalize.ts`, `port.ts`, `channel.ts` |
| Mock | `src/ingress/mock/channel.ts` | 内存出站记录 + `emitMessage` 注入 |
| 接线 | `bootstrap.ts` | `createLarkIngressChannel` + `handleNormalized` |

## 验收

- [x] 飞书行为无回归（`handle` 保留，`handleNormalized` 为推荐入口）
- [x] `ingress/mock` 集成测试不依赖飞书凭据
- [x] CardRenderer / RunCardController / 媒体下载经 `IngressPort`
- [x] `ingress/slack` 骨架（registry 可发现，Socket Mode 待实现）
- [ ] `lark/` 目录迁入（当前仍在 `src/lark/`，经 adapter 桥接）
- [ ] 第二渠道生产可用（Slack Socket Mode）

## 下一步

1. 将 `src/lark/parse.ts` 等媒体下载逐步包进 `LarkIngressChannel` 入站 enrich
2. `dispatcher` 内部逐步用 `NormalizedMessage` 字段名（`conversationId`）替代 `chatId`
3. Slack 作为第二个 `IngressChannel` 验证抽象是否足够

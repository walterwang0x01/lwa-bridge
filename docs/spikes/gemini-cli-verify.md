# Spike：Gemini CLI 本机验证

> 状态：**适配器已接入** — 本机需安装 `@google/gemini-cli` 后做端到端验证。

## 安装

```bash
npm install -g @google/gemini-cli
gemini --version
```

## 配额探测

```bash
gemini quota --json
```

Bridge 在 `src/runtime/nativeQuotaProbe.ts` 解析此 JSON；Dashboard 与路由 fallback 已接线。

## 路由

配置 `runtime.profiles.gemini` 或 `/runtime gemini`；smart 模式下高 volume + 简单任务可命中 gemini（见 `router.ts`）。

## 本机 smoke（手动）

```bash
# 1. 确认 registry 可见
lark-kiro-bridge run   # 启动后 Dashboard /api/overview 应含 gemini profile

# 2. 飞书发消息前切换
/runtime gemini

# 3. 发一条简单任务，确认日志 runtimeKind=gemini-cli
```

## 自动化

- `src/runtime/geminiStreamParser.test.ts` — NDJSON 解析
- `src/runtime/geminiCliRuntime.test.ts` — 适配器契约
- CI 不依赖本机 `gemini` 二进制（`which gemini` 可选）

## 验收（路线图剩余）

- [ ] 本机 `gemini` 安装后跑通一条 chat turn
- [ ] adaptive 分桶出现 gemini 推荐行

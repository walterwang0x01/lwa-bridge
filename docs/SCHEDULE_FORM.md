# /schedule new — 可视化定时任务创建表单

让非技术用户（HR / 销售 / 行政等）也能在飞书里建定时任务，0 cron 表达式心智。

## 工作模式

```
[用户] /schedule new
   ↓
[Bot]  📅 表单卡片（所有字段在一个 form 容器里）
       小时:    [9]
       分钟:    [0]
       内容:    [____________]   ← 必填
       任务名:  [____________]   ← 可选
       [✅ 创建]   [取消]
   ↓
[用户] 填字段，点 ✅ 创建
   ↓
[Bot]  ✅ 已创建 abc12345
       频率：每天 09:00
       下次触发：2026-05-26 09:00 (周二)
   ↓
[到点] cron scheduler 触发
       将"内容"作为一条用户消息发给 Kiro 处理
```

## 当前覆盖范围

仅支持「**每天 H:M**」频率。

## 为什么不做 6 种频率切换？

设计阶段考虑过频率下拉切换 + 表单字段动态变化（每天 / 工作日 / 每周多选 / 每月 / 一次性 / 自定义 cron），实现时遇到飞书 v2 卡片协议的多个客户端兼容性问题，最后定下当前最简方案：

1. **`multi_select_static` 不被部分飞书客户端支持** — `weekdays` 多选会让客户端直接拒发请求（错误码 200621：`unknown property: initial_options`）
2. **form 内字段切换无法平滑实现** — 飞书 form 是一次性提交结构，切换频率要重发整张卡片，UI 体验断裂
3. **form 内 button 必须有 `name` 字段** — 飞书客户端隐藏校验（错误码 200530），此项目历史 form 卡片都缺这个属性，schedule 表单是首次发现并修正

工程师场景已经被 `/cron add` 完整覆盖，HR/销售最常见的是"每天定时提醒"，所以当前一种频率已经覆盖 95% 真实需求。

## 后续扩展（v0.7+）

如果有需求，后续可以加 slash 命令变体：

- `/schedule new` → 当前的每天表单
- `/schedule weekday` → 工作日表单（同结构，prompt 加"工作日"标签）
- `/schedule once` → 一次性表单（多一个日期 input）
- 其他高级用法继续走 `/cron add`

每个变体都是独立卡片，不在同一卡片内切换字段——避开 multi_select_static / 字段动态切换的坑。

## 数据流

```
/schedule new
  ↓ parseCommand → { kind: 'schedule', mode: 'new' }
  ↓
dispatcher.handleScheduleCmd
  ↓ buildScheduleFormCard({ state: { frequency: 'daily', hour: 9, minute: 0 } })
  ↓
飞书显示表单卡

[用户填表 + 点创建]
  ↓ card.action.trigger { action: 'schedule.submit', form_value: { hour, minute, prompt, name } }
  ↓
dispatcher.handleScheduleSubmit
  ↓ formToCron({ frequency: 'daily', hour, minute })
  ↓ cronStore.create + cronScheduler.register
  ↓ patchCard → 成功提示
```

## 关键技术决策

### 1. cron store 加 `runOnce` 字段（Step 1）

为「一次性任务」预留底层支持：scheduler 触发后检查 `task.runOnce`，true 就自动 unregister + delete。当前 daily 频率不用，但底层已经准备好。

### 2. `formToCron` 转换器（Step 2）

`src/cron/scheduleForm.ts` 提供 6 种频率到 cron 5 段的转换：daily / weekday / weekly / monthly / once / custom。当前 UI 只暴露 daily，但转换器全部实现并有 31 个单测覆盖。这样未来加新频率变体时只改 UI，转换器零改动。

### 3. 命令路由（Step 3）

`/schedule new` 是新命令；`/schedule list/rm/...` 复用 `/cron list/rm/...` 的逻辑。这样：
- `/cron *` → 工程师入口（cron 表达式 + 完整管理）
- `/schedule new` → 小白入口（表单）
- 底层共用同一个 `~/.lark-kiro-bridge/cron.json`

### 4. 飞书 form schema 兼容性（Step 5）

照搬 [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) v0.1.32 的 `config-card.ts` 模板。关键属性：

- 顶层用 `config: { summary: { content: '...' } }`，**不用** `header: { template: 'blue' }`
- form 内 button 必须带 `name` 字段（隐藏要求）
- input 加 `input_type: 'text'`
- button.type = `'primary'`，**不是** `'primary_filled'`
- column 只用 `width: 'auto'`，不用 weighted/weight
- form 内只能放 markdown / input / button / column_set / hr —— 不嵌套 form

### 5. cron prompt 的"使用范式"

到点触发时，bridge 把 prompt 当成一条普通用户消息发给 Kiro。这意味着：

- prompt 写"记得喝水" → Kiro 会回"谢谢提醒，你也记得喝水 🥤"（把它当对话）
- prompt 写"在群里发一条消息：💧 该喝水了" → Kiro 会执行（把它当指令）

这个范式跟 Slack 的 `/remind`（直接展示文本）不同——我们的每次触发都过一遍 LLM。

## 测试策略

- 单元测试：`src/cron/scheduleForm.test.ts` 覆盖 31 个 case（6 种频率正常路径 + 错误分支 + 边界）
- 手动测试：参考 `docs/FAQ.md` 里的「定时任务」章节

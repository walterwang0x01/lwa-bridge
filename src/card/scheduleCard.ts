/**
 * /schedule new 可视化定时任务表单卡片
 *
 * 设计目标：让非技术用户也能在飞书里建定时任务，0 cron 表达式心智。
 *
 * 实现策略（B 方案 v2）：
 *   严格照搬 zarazhangrui/feishu-claude-code-bridge v0.1.32 的 config-card.ts 模板
 *   （529 stars 上游项目，生产稳定）。关键 schema 差异（vs 本项目当前 buildConfigFormCard）：
 *
 *   1. 顶层用 `config: { summary: { content: '...' } }`，不用 header
 *   2. button 必须带 `name` 字段（form 内的提交/取消按钮）
 *   3. input 加 `input_type: 'text'`
 *   4. button.type = 'primary'（不是 'primary_filled'）
 *   5. column 只用 `width: 'auto'`，不用 weighted/weight/vertical_align
 *   6. form 内**只能放** input/select_static/markdown/hr/button/column_set —— 不要 form 嵌套
 *
 *   这些差异是飞书 v2 schema 客户端校验的隐藏要求。本项目 buildConfigFormCard 缺这些属性
 *   导致 /config 提交时也报 200530 —— 是已知 bug，下个迭代会一并修。
 *
 * MVP 仅支持「每天 H:M」频率。其他频率请用 `/cron add`。
 */
import type { ScheduleFrequency } from '../cron/scheduleForm.js';

export type { ScheduleFrequency };

/** 表单显示状态（出错回填用）*/
export interface ScheduleFormState {
  frequency: ScheduleFrequency;
  hour?: number;
  minute?: number;
  prompt?: string;
  name?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  date?: string;
  expression?: string;
}

/**
 * 主入口：构造 /schedule new 表单卡片
 */
export function buildScheduleFormCard(opts: {
  state: ScheduleFormState;
  /** 提交校验失败时显示在顶部的错误信息 */
  error?: string;
}): object {
  const { state, error } = opts;
  const hour = state.hour ?? 9;
  const minute = state.minute ?? 0;
  const prompt = state.prompt ?? '';
  const name = state.name ?? '';

  const formInnerElements: object[] = [];

  if (error) {
    formInnerElements.push({
      tag: 'markdown',
      content: `<font color='red'>⚠️ ${error}</font>`,
    });
  }

  formInnerElements.push(
    {
      tag: 'markdown',
      content: '**⏰ 触发时间**\n_输入小时（0-23）和分钟（0-59）。例如 9:30 早会提醒_',
    },
    {
      tag: 'input',
      name: 'hour',
      default_value: String(hour),
      placeholder: { tag: 'plain_text', content: '9' },
      input_type: 'text',
    },
    {
      tag: 'input',
      name: 'minute',
      default_value: String(minute),
      placeholder: { tag: 'plain_text', content: '0' },
      input_type: 'text',
    },
    {
      tag: 'markdown',
      content: '\n**📝 内容**（必填）\n_到点要让 Kiro 做什么。例：总结昨天的 git commits_',
    },
    {
      tag: 'input',
      name: 'prompt',
      default_value: prompt,
      placeholder: { tag: 'plain_text', content: '总结昨天的 git commits' },
      input_type: 'text',
    },
    {
      tag: 'markdown',
      content: '\n**🏷️ 任务名**（可选）\n_用于在 /cron list 里识别这条任务。留空自动取内容前 20 字_',
    },
    {
      tag: 'input',
      name: 'name',
      default_value: name,
      placeholder: { tag: 'plain_text', content: '留空则自动生成' },
      input_type: 'text',
    },
    {
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              name: 'submit_btn',
              text: { tag: 'plain_text', content: '✅ 创建' },
              type: 'primary',
              form_action_type: 'submit',
              behaviors: [
                {
                  type: 'callback',
                  value: { action: 'schedule.submit' },
                },
              ],
            },
          ],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              name: 'cancel_btn',
              text: { tag: 'plain_text', content: '取消' },
              behaviors: [
                {
                  type: 'callback',
                  value: { action: 'schedule.cancel' },
                },
              ],
            },
          ],
        },
      ],
    },
  );

  return {
    schema: '2.0',
    config: { summary: { content: '新建定时任务' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '📅 **新建定时任务（每天）**\n\n' +
            '让 Kiro 在每天指定时间执行一段任务。改完点 ✅ 创建即生效。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'schedule_form',
          elements: formInnerElements,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content:
            '<font color="grey">💡 当前只支持「每天」频率。其他频率请用 `/cron add`，例如：</font>\n' +
            '`/cron add 0 9 * * 1-5 工作日早会提醒`',
        },
      ],
    },
  };
}

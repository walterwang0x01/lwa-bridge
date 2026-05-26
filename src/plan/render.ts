/**
 * Plan 卡片元素渲染
 *
 * 不是完整卡片——返回一组 element，由 RunCardController 嵌入到主任务卡顶部。
 * 这样保持"一张卡片"的体验，不另起新卡。
 *
 * 视觉：
 *   📋 任务计划（3/5）
 *   ✅ 写 HTML 文件
 *   ✅ Chrome headless 截图
 *   ⏳ Python PIL 切片            ← 进行中
 *   ☐ 上传飞书图片
 *   ☐ 发送图片消息
 */
import type { Plan, PlanItem } from './types.js';
import { planProgress } from './types.js';

const STATUS_ICON: Record<PlanItem['status'], string> = {
  pending: '☐',
  in_progress: '⏳',
  done: '✅',
  failed: '❌',
  skipped: '⏭️',
};

/**
 * 把 Plan 渲染成飞书卡片 element 数组，调用方拼到主任务卡的顶部。
 *
 * 设计：
 *   - 用 markdown 元素而不是 list 元素，方便整体折叠
 *   - 进度条用纯文本风格 (3/5) 而不是 progress_bar 元素，节省高度
 *   - failed 步骤展开 detail，其他不展开（减少卡片视觉噪音）
 */
export function renderPlanElements(plan: Plan): object[] {
  if (plan.items.length === 0) return [];

  const total = plan.items.length;
  const done = plan.items.filter((i) => i.status === 'done').length;
  const skipped = plan.items.filter((i) => i.status === 'skipped').length;
  const failed = plan.items.filter((i) => i.status === 'failed').length;
  const finished = done + skipped;

  // 头部摘要：根据整体状态选标题图标
  const headerIcon =
    plan.status === 'completed'
      ? '✅'
      : plan.status === 'failed' || failed > 0
        ? '❌'
        : plan.status === 'cancelled'
          ? '⏹'
          : plan.status === 'planning'
            ? '📋'
            : '📋';

  const titleText = plan.title ? ` ${plan.title}` : '';
  const headerLine = `**${headerIcon} 任务计划${titleText}（${finished}/${total}）**`;

  // 步骤列表
  const itemLines = plan.items.map((item) => {
    const icon = STATUS_ICON[item.status];
    let line = `${icon} ${escapeMd(item.title)}`;
    // 失败时展开 detail；进行中且有 detail 也展开（用户能看到当前在干啥）
    if (item.detail && (item.status === 'failed' || item.status === 'in_progress')) {
      line += ` <font color='grey'>— ${escapeMd(item.detail)}</font>`;
    }
    return line;
  });

  return [
    {
      tag: 'markdown',
      content: [headerLine, '', ...itemLines].join('\n'),
    },
    // 分隔线（hr）让 plan 跟下面 Kiro 输出有视觉分隔
    { tag: 'hr' },
  ];
}

/** 飞书 markdown 里的特殊字符转义 */
function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

/** 调用方需要的辅助：plan 是否值得展示（空 plan 不展示） */
export function shouldShowPlan(plan: Plan | undefined): plan is Plan {
  return plan !== undefined && plan.items.length > 0;
}

// 让 progress 可以被外部访问（测试 / 摘要文案用）
export { planProgress };

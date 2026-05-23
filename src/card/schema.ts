/**
 * 飞书消息卡片 (interactive card v2) 构造器
 *
 * 我们维护一张状态机驱动的卡片：
 *   pending   → "⏳ 正在思考..."（首次发送）
 *   streaming → 标题 "🤖 Kiro" + 流式文本
 *   done      → 标题 "✅ Kiro" + 完整文本 + 操作按钮（重置 / 帮助）
 *   aborted   → 标题 "⏹️ 已中止" + 已收到的部分文本
 *   timedout  → 标题 "⏱️ 超时" + 提示
 *   error     → 标题 "❌ 错误" + 错误信息
 *
 * 状态切换由 CardRenderer.update(state, text?) 触发。
 * 卡片用飞书的 v2 JSON schema（schema 字段为 "2.0"）。
 */
export type CardState = 'pending' | 'streaming' | 'done' | 'aborted' | 'timedout' | 'error';

export interface CardContext {
  cwd: string;
  workspaceName?: string;
  /** 是否在卡片底部显示工作区角标 */
  showFooter?: boolean;
}

const HEADER_TEMPLATES: Record<CardState, { title: string; template: string }> = {
  pending: { title: '⏳ Kiro 正在思考...', template: 'blue' },
  streaming: { title: '🤖 Kiro 正在回复', template: 'blue' },
  done: { title: '✅ Kiro', template: 'green' },
  aborted: { title: '⏹️ 已中止', template: 'orange' },
  timedout: { title: '⏱️ 超时', template: 'red' },
  error: { title: '❌ 出错', template: 'red' },
};

/**
 * 构造一张完整的卡片 JSON。
 *
 * @param state    当前卡片状态
 * @param body     卡片正文（Markdown）
 * @param ctx      上下文（cwd、工作区名）
 * @param showStop 是否显示停止按钮（streaming 时为 true）
 */
export function buildCard(
  state: CardState,
  body: string,
  ctx: CardContext,
  showStop = false,
): object {
  const header = HEADER_TEMPLATES[state];
  const elements: object[] = [];

  // 正文。空字符串时给个占位，避免飞书拒绝空卡片
  const bodyText = body.trim() || (state === 'pending' ? '_（等待 Kiro 响应...）_' : '_（无输出）_');
  elements.push({
    tag: 'markdown',
    content: bodyText,
  });

  // 操作按钮区
  const actions: object[] = [];
  if (showStop && (state === 'pending' || state === 'streaming')) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏹ 停止' },
      type: 'danger',
      value: { action: 'stop' },
    });
  }
  if (state === 'done' || state === 'error' || state === 'timedout' || state === 'aborted') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔄 重置会话' },
      type: 'default',
      value: { action: 'new' },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '❓ 帮助' },
      type: 'default',
      value: { action: 'help' },
    });
  }
  if (actions.length > 0) {
    elements.push({ tag: 'action', actions });
  }

  // 底部工作区角标
  if (ctx.showFooter !== false) {
    const wsLabel = ctx.workspaceName ? `\`${ctx.workspaceName}\` ` : '';
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `${wsLabel}${ctx.cwd}`,
        },
      ],
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: header.title },
      template: header.template,
    },
    body: { elements },
  };
}

/**
 * 把流式累积的文本截到飞书卡片可承载的长度。
 * 飞书卡片 element 内容长度上限大约 30k 字节，留点余量截到 20k。
 */
export function truncateForCard(text: string, maxBytes = 20_000): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= maxBytes) return text;
  // 截到 maxBytes 字节，再保险地 slice 回字符串（可能尾部多字节字符被截断，转码会丢失）
  const cut = buf.subarray(0, maxBytes).toString('utf-8');
  return cut + '\n\n_…内容超出卡片上限，已截断_';
}

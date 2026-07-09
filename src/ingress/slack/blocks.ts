import type { ActionsBlock, KnownBlock } from '@slack/types';

/**
 * 将飞书 interactive card JSON 转为 Slack Block Kit（尽力映射）。
 * 复杂布局（column_set 等）会降级为 markdown 文本；按钮映射为 block_actions。
 */
export function larkCardToSlackPayload(card: unknown): { text: string; blocks: KnownBlock[] } {
  const texts: string[] = [];
  const buttons: Array<{ text: string; value: string }> = [];
  walkNode(card, texts, buttons);

  const text = texts.join('\n\n').trim() || ' ';
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: text.slice(0, 3000) },
    },
  ];

  if (buttons.length > 0) {
    const actions: ActionsBlock = {
      type: 'actions',
      elements: buttons.slice(0, 5).map((b) => ({
        type: 'button',
        text: { type: 'plain_text', text: b.text.slice(0, 75), emoji: true },
        value: b.value.slice(0, 2000),
      })),
    };
    blocks.push(actions);
  }

  return { text: text.slice(0, 39000), blocks };
}

function walkNode(
  node: unknown,
  texts: string[],
  buttons: Array<{ text: string; value: string }>,
): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (obj.tag === 'markdown' && typeof obj.content === 'string') {
    texts.push(stripLarkFontTags(obj.content));
    return;
  }

  if (obj.tag === 'plain_text' && typeof obj.content === 'string') {
    texts.push(obj.content);
    return;
  }

  if (obj.tag === 'button') {
    const text = extractPlainText(obj.text);
    const value = JSON.stringify(obj.value ?? {});
    if (text) buttons.push({ text, value });
    return;
  }

  const header = obj.header as Record<string, unknown> | undefined;
  if (header?.title) {
    const title = extractPlainText(header.title) || extractMarkdown(header.title);
    if (title) texts.push(`*${title}*`);
  }

  const body = obj.body as { elements?: unknown[] } | undefined;
  if (body?.elements) {
    for (const el of body.elements) walkNode(el, texts, buttons);
  }

  if (Array.isArray(obj.elements)) {
    for (const el of obj.elements) walkNode(el, texts, buttons);
  }

  if (Array.isArray(obj.columns)) {
    for (const col of obj.columns) walkNode(col, texts, buttons);
  }
}

function extractPlainText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const o = node as { content?: string; tag?: string };
  if (o.tag === 'plain_text' && typeof o.content === 'string') return o.content;
  return '';
}

function extractMarkdown(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const o = node as { content?: string; tag?: string };
  if (o.tag === 'markdown' && typeof o.content === 'string') return stripLarkFontTags(o.content);
  return '';
}

function stripLarkFontTags(s: string): string {
  return s
    .replace(/<font[^>]*>/gi, '')
    .replace(/<\/font>/gi, '')
    .trim();
}

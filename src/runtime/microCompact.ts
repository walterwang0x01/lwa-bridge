/**
 * Micro-compact：截断过大的单条消息 / 工具输出，避免把日志撑爆上下文。
 */
import type { CompactMessage } from './compact.js';

const DEFAULT_MAX_PER_MESSAGE = 8_000;

export function microCompactText(text: string, maxChars = DEFAULT_MAX_PER_MESSAGE): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head - 40;
  return `${text.slice(0, head)}\n…[micro-compact truncated ${text.length - maxChars} chars]…\n${text.slice(-Math.max(0, tail))}`;
}

export function microCompactMessages(
  messages: CompactMessage[],
  maxPerMessage = DEFAULT_MAX_PER_MESSAGE,
): CompactMessage[] {
  return messages.map((m) => ({
    ...m,
    content: microCompactText(m.content, maxPerMessage),
  }));
}

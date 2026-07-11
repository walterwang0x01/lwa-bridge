/**
 * 估算会话上下文体积，并判断是否应触发 auto-compact。
 * 粗略按字符数（≈ token*4），不追求精确 tokenizer。
 */
import type { CompactMessage } from './compact.js';

export function estimateContextChars(messages: CompactMessage[], extras: string[] = []): number {
  let n = 0;
  for (const m of messages) n += m.content.length + 16;
  for (const e of extras) n += e.length;
  return n;
}

export function shouldAutoCompact(opts: {
  chars: number;
  thresholdChars: number;
  enabled: boolean;
  /** 距上次 compact 的毫秒；过近则跳过，防抖 */
  lastCompactAt?: number;
  cooldownMs?: number;
}): boolean {
  if (!opts.enabled) return false;
  if (opts.chars < opts.thresholdChars) return false;
  const cooldown = opts.cooldownMs ?? 60_000;
  if (opts.lastCompactAt && Date.now() - opts.lastCompactAt < cooldown) return false;
  return true;
}

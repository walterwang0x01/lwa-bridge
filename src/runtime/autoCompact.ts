/**
 * 估算会话上下文体积，并判断是否应触发 auto-compact。
 * 粗略：chars / 4 ≈ tokens（与主流 CLI 一致的启发式，非精确 tokenizer）。
 */
import type { CompactMessage } from './compact.js';

export function estimateContextChars(messages: CompactMessage[], extras: string[] = []): number {
  let n = 0;
  for (const m of messages) n += m.content.length + 16;
  for (const e of extras) n += e.length;
  return n;
}

/** ≈ tokens；CJK 略偏保守（按字符算再 /4）。 */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
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

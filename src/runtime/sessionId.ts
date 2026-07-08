/**
 * 跨 runtime 的 session id 编解码。
 *
 * 存储格式：`{runtimeKind}:{nativeId}`，避免 kiro / cursor session 混用。
 * 旧数据无冒号前缀时视为 kiro-acp 原生 id（向后兼容）。
 */
import { RUNTIME_KINDS, type RuntimeKind } from './types.js';

export function encodeSessionId(kind: RuntimeKind, nativeId: string): string {
  const trimmed = nativeId.trim();
  if (!trimmed) return trimmed;
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon) as RuntimeKind;
    if (RUNTIME_KINDS.has(prefix)) return trimmed;
  }
  return `${kind}:${trimmed}`;
}

export function decodeSessionId(
  stored: string | undefined,
  expectedKind: RuntimeKind,
): string | undefined {
  if (!stored) return undefined;
  const colon = stored.indexOf(':');
  if (colon > 0) {
    const prefix = stored.slice(0, colon) as RuntimeKind;
    if (RUNTIME_KINDS.has(prefix)) {
      if (prefix !== expectedKind) return undefined;
      return stored.slice(colon + 1);
    }
  }
  // 遗留：无前缀的 id 仅对 kiro-acp 有效
  if (expectedKind === 'kiro-acp') return stored;
  return undefined;
}

/**
 * 解析 gemini-cli `gemini -p ... --output-format stream-json` 的 NDJSON 行。
 *
 * 事件类型见官方 headless 文档：init / message / tool_use / tool_result / error / result
 */
import type { UnifiedSessionEvent } from './types.js';

export interface GeminiStreamState {
  sessionId: string;
}

function extractMessageText(obj: Record<string, unknown>): string {
  const content = obj.content;
  if (typeof content === 'string' && content) return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const block = part as Record<string, unknown>;
          if (typeof block.text === 'string') return block.text;
        }
        return '';
      })
      .join('');
  }
  const message = obj.message as Record<string, unknown> | undefined;
  if (message) return extractMessageText(message);
  if (typeof obj.text === 'string') return obj.text;
  return '';
}

export function parseGeminiStreamLine(
  line: string,
  state: GeminiStreamState,
): UnifiedSessionEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = String(obj.type ?? '');
  const sessionId =
    typeof obj.session_id === 'string'
      ? obj.session_id
      : typeof obj.sessionId === 'string'
        ? obj.sessionId
        : state.sessionId || 'gemini';

  if (type === 'init') {
    if (typeof obj.session_id === 'string') state.sessionId = obj.session_id;
    else if (typeof obj.sessionId === 'string') state.sessionId = obj.sessionId;
    return [];
  }

  if (type === 'message') {
    const role = String(obj.role ?? 'assistant');
    if (role !== 'assistant' && role !== 'model') return [];
    const text = extractMessageText(obj);
    if (text) return [{ kind: 'message', sessionId, text }];
    return [];
  }

  if (type === 'tool_use' || type === 'tool_result') {
    return [
      {
        kind: 'tool',
        sessionId,
        toolCallId: String(obj.id ?? obj.tool_use_id ?? obj.call_id ?? ''),
        name: String(obj.name ?? obj.tool_name ?? 'tool'),
        status: type === 'tool_use' ? 'started' : 'completed',
        raw: obj,
      },
    ];
  }

  if (type === 'error') {
    const message = String(obj.message ?? obj.error ?? 'gemini error');
    return [{ kind: 'message', sessionId, text: `⚠️ ${message}` }];
  }

  if (type === 'result') {
    return [{ kind: 'turn_end', sessionId, stopReason: String(obj.status ?? 'end_turn') }];
  }

  return [];
}

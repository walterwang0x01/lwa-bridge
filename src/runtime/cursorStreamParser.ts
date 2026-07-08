/**
 * 解析 cursor-agent `agent --print --output-format stream-json` 的 NDJSON 行。
 */
import type { UnifiedSessionEvent } from './types.js';

export interface CursorStreamState {
  sessionId: string;
}

export function parseCursorStreamLine(
  line: string,
  state: CursorStreamState,
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
    typeof obj.session_id === 'string' ? obj.session_id : state.sessionId || 'cursor';

  if (type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
    state.sessionId = obj.session_id;
    return [];
  }

  if (type === 'thinking') {
    const subtype = String(obj.subtype ?? '');
    if (subtype === 'delta' && typeof obj.text === 'string' && obj.text) {
      return [{ kind: 'thought', sessionId, text: obj.text }];
    }
    return [];
  }

  if (type === 'assistant') {
    const message = obj.message as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const parts = message?.content ?? [];
    const text = parts
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (text) return [{ kind: 'message', sessionId, text }];
    return [];
  }

  if (type === 'tool_call' || type === 'tool_call_update') {
    const raw = obj as Record<string, unknown>;
    return [
      {
        kind: 'tool',
        sessionId,
        toolCallId: String(obj.call_id ?? obj.tool_call_id ?? obj.id ?? ''),
        name: String(obj.name ?? obj.tool_name ?? 'tool'),
        status: String(obj.subtype ?? obj.status ?? 'unknown'),
        raw,
      },
    ];
  }

  if (type === 'result') {
    const usage = obj.usage as Record<string, unknown> | undefined;
    const events: UnifiedSessionEvent[] = [
      { kind: 'turn_end', sessionId, stopReason: String(obj.subtype ?? 'end_turn') },
    ];
    if (usage) {
      events.push({
        kind: 'metadata',
        sessionId,
        turnDurationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
      });
    }
    return events;
  }

  return [];
}

/**
 * lwa-conduit NDJSON 事件协议（`lwa.conduit.event/v1`）。
 * 与 Python `lwa_conduit.event_export` 对齐。
 */
export const CONDUIT_EVENT_SCHEMA = 'lwa.conduit.event/v1';

export type ConduitEventType =
  | 'WaveStarted'
  | 'TaskStarted'
  | 'TaskFinished'
  | 'LockEvent'
  | 'MergeStarted'
  | 'MergeFinished'
  | 'RunCompleted';

export interface ConduitEventBase {
  schema: typeof CONDUIT_EVENT_SCHEMA;
  type: ConduitEventType;
  ts: number;
}

export interface WaveStartedEvent extends ConduitEventBase {
  type: 'WaveStarted';
  wave_index: number;
  total_waves: number;
  task_ids: string[];
  skipped_ids?: string[];
}

export interface TaskStartedEvent extends ConduitEventBase {
  type: 'TaskStarted';
  task_id: string;
  attempt: number;
  max_attempts: number;
}

export interface TaskFinishedEvent extends ConduitEventBase {
  type: 'TaskFinished';
  task_id: string;
  attempt: number;
  passed: boolean;
  failed_layer?: string | null;
}

export interface LockEventPayload extends ConduitEventBase {
  type: 'LockEvent';
  file_path: string;
  task_id: string;
  action: string;
  policy: string;
}

export interface MergeStartedEvent extends ConduitEventBase {
  type: 'MergeStarted';
  task_id: string;
}

export interface MergeFinishedEvent extends ConduitEventBase {
  type: 'MergeFinished';
  task_id: string;
  merged: boolean;
  error?: string | null;
}

export interface RunCompletedEvent extends ConduitEventBase {
  type: 'RunCompleted';
  passed_count: number;
  failed_count: number;
  skipped_count: number;
}

export type ConduitEvent =
  | WaveStartedEvent
  | TaskStartedEvent
  | TaskFinishedEvent
  | LockEventPayload
  | MergeStartedEvent
  | MergeFinishedEvent
  | RunCompletedEvent;

const KNOWN_TYPES = new Set<string>([
  'WaveStarted',
  'TaskStarted',
  'TaskFinished',
  'LockEvent',
  'MergeStarted',
  'MergeFinished',
  'RunCompleted',
]);

/** 尝试把一行文本解析为 conduit 事件；非事件行返回 null。 */
export function parseConduitEventLine(line: string): ConduitEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj.schema !== CONDUIT_EVENT_SCHEMA) return null;
    if (typeof obj.type !== 'string' || !KNOWN_TYPES.has(obj.type)) return null;
    if (typeof obj.ts !== 'number') return null;
    return obj as unknown as ConduitEvent;
  } catch {
    return null;
  }
}

/**
 * 从合并输出缓冲中抽出完整行并解析事件。
 * 返回未完成的尾部（不含换行）供下次拼接。
 */
export function consumeConduitEventLines(
  chunk: string,
  carry: string,
): { events: ConduitEvent[]; carry: string; humanLines: string[] } {
  const combined = carry + chunk;
  const parts = combined.split(/\r?\n/);
  const nextCarry = parts.pop() ?? '';
  const events: ConduitEvent[] = [];
  const humanLines: string[] = [];
  for (const line of parts) {
    const ev = parseConduitEventLine(line);
    if (ev) events.push(ev);
    else if (line.length > 0) humanLines.push(line);
  }
  return { events, carry: nextCarry, humanLines };
}

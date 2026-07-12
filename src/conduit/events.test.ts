import { describe, it, expect } from 'vitest';
import { CONDUIT_EVENT_SCHEMA, consumeConduitEventLines, parseConduitEventLine } from './events.js';
import { applyConduitEvent, createEmptyProgress, formatProgressText } from './progress.js';

describe('parseConduitEventLine', () => {
  it('parses valid WaveStarted', () => {
    const line = JSON.stringify({
      schema: CONDUIT_EVENT_SCHEMA,
      type: 'WaveStarted',
      ts: 1.5,
      wave_index: 1,
      total_waves: 2,
      task_ids: ['a'],
    });
    const ev = parseConduitEventLine(line);
    expect(ev?.type).toBe('WaveStarted');
    if (ev?.type === 'WaveStarted') {
      expect(ev.wave_index).toBe(1);
      expect(ev.task_ids).toEqual(['a']);
    }
  });

  it('rejects non-json and wrong schema', () => {
    expect(parseConduitEventLine('hello')).toBeNull();
    expect(
      parseConduitEventLine(JSON.stringify({ schema: 'other', type: 'WaveStarted', ts: 1 })),
    ).toBeNull();
  });
});

describe('consumeConduitEventLines', () => {
  it('splits events from human log and keeps carry', () => {
    const ev = JSON.stringify({
      schema: CONDUIT_EVENT_SCHEMA,
      type: 'TaskStarted',
      ts: 1,
      task_id: 't1',
      attempt: 1,
      max_attempts: 3,
    });
    const r1 = consumeConduitEventLines(`log line\n${ev}\npartial`, '');
    expect(r1.humanLines).toEqual(['log line']);
    expect(r1.events).toHaveLength(1);
    expect(r1.carry).toBe('partial');

    // flush incomplete carry as human text, then a complete event
    const done = JSON.stringify({
      schema: CONDUIT_EVENT_SCHEMA,
      type: 'RunCompleted',
      ts: 2,
      passed_count: 1,
      failed_count: 0,
      skipped_count: 0,
    });
    const r2 = consumeConduitEventLines(`\n${done}\n`, r1.carry);
    expect(r2.humanLines).toContain('partial');
    expect(r2.events.some((e) => e.type === 'RunCompleted')).toBe(true);
  });
});

describe('progress state', () => {
  it('tracks wave and task counts', () => {
    let s = createEmptyProgress();
    s = applyConduitEvent(s, {
      schema: CONDUIT_EVENT_SCHEMA,
      type: 'WaveStarted',
      ts: 1,
      wave_index: 1,
      total_waves: 2,
      task_ids: ['a', 'b'],
    });
    s = applyConduitEvent(s, {
      schema: CONDUIT_EVENT_SCHEMA,
      type: 'TaskStarted',
      ts: 2,
      task_id: 'a',
      attempt: 1,
      max_attempts: 3,
    });
    s = applyConduitEvent(s, {
      schema: CONDUIT_EVENT_SCHEMA,
      type: 'TaskFinished',
      ts: 3,
      task_id: 'a',
      attempt: 1,
      passed: true,
    });
    const text = formatProgressText(s);
    expect(text).toContain('Wave 1/2');
    expect(text).toContain('✅1');
    expect(s.tasks.a?.status).toBe('passed');
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyConduitEvent,
  createEmptyProgress,
  formatProgressOneLiner,
  formatProgressText,
} from './progress.js';
import { CONDUIT_EVENT_SCHEMA } from './events.js';
import { ConduitRunRegistry } from './registry.js';

const base = { schema: CONDUIT_EVENT_SCHEMA, ts: Date.now() } as const;

describe('conduit progress one-liner', () => {
  it('formats wave and task counts', () => {
    let state = createEmptyProgress();
    state = applyConduitEvent(state, {
      ...base,
      type: 'WaveStarted',
      wave_index: 1,
      total_waves: 3,
      task_ids: ['a', 'b'],
    });
    state = applyConduitEvent(state, {
      ...base,
      type: 'TaskStarted',
      task_id: 'a',
      attempt: 1,
      max_attempts: 2,
    });
    const line = formatProgressOneLiner(state);
    expect(line).toContain('Wave 1/3');
    expect(line).toContain('a');
    expect(formatProgressText(state)).toContain('Wave 1/3');
  });
});

describe('ConduitRunRegistry', () => {
  it('tracks active runs and finishes', () => {
    const reg = new ConduitRunRegistry();
    reg.start('cli-code', '/tmp/proj');
    expect(reg.hasActive()).toBe(true);
    reg.update('cli-code', {
      progress: applyConduitEvent(createEmptyProgress(), {
        ...base,
        type: 'WaveStarted',
        wave_index: 2,
        total_waves: 4,
        task_ids: ['t1'],
      }),
    });
    expect(reg.get('cli-code')?.progress.currentWave).toBe(2);
    expect(reg.listActive()).toHaveLength(1);
    reg.finish('cli-code');
    expect(reg.hasActive()).toBe(false);
  });
});

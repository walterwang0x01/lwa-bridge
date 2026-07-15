import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ChatPipeline, type PipelineTask } from './pipeline.js';

function preemptibleTask(
  id: string,
  state: { active: number; maxActive: number; events: string[] },
  finishImmediately = false,
): PipelineTask {
  return {
    id,
    run: async (signal) => {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      state.events.push(`${id}:start`);
      try {
        if (!finishImmediately) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      } finally {
        state.events.push(`${id}:${signal.aborted ? 'abort' : 'done'}`);
        state.active -= 1;
      }
    },
  };
}

describe('ChatPipeline', () => {
  it('serializes concurrent preemption transitions for one chat', async () => {
    const state = { active: 0, maxActive: 0, events: [] as string[] };
    const pipeline = new ChatPipeline('chat-1', pino({ enabled: false }));

    const first = pipeline.submit(preemptibleTask('a', state));
    await Promise.resolve();
    const second = pipeline.submit(preemptibleTask('b', state));
    const third = pipeline.submit(preemptibleTask('c', state, true));

    await Promise.all([first, second, third]);

    expect(state.maxActive).toBe(1);
    expect(state.active).toBe(0);
    expect(state.events).toEqual(['a:start', 'a:abort', 'b:start', 'b:abort', 'c:start', 'c:done']);
    expect(pipeline.hasActiveTask()).toBe(false);
  });
});

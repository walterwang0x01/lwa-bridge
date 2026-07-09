import { describe, expect, it } from 'vitest';
import { parseGeminiStreamLine } from './geminiStreamParser.js';

describe('parseGeminiStreamLine', () => {
  it('parses init, assistant message, tool, and result', () => {
    const state = { sessionId: '' };

    expect(
      parseGeminiStreamLine(
        JSON.stringify({ type: 'init', session_id: 'g-sess-1', model: 'auto' }),
        state,
      ),
    ).toEqual([]);
    expect(state.sessionId).toBe('g-sess-1');

    const msg = parseGeminiStreamLine(
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello' }),
      state,
    );
    expect(msg).toEqual([{ kind: 'message', sessionId: 'g-sess-1', text: 'Hello' }]);

    const tool = parseGeminiStreamLine(
      JSON.stringify({ type: 'tool_use', id: 't1', name: 'run_shell' }),
      state,
    );
    expect(tool[0]?.kind).toBe('tool');

    const end = parseGeminiStreamLine(JSON.stringify({ type: 'result', status: 'success' }), state);
    expect(end[0]).toMatchObject({ kind: 'turn_end' });
  });
});

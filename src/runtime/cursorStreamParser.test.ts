import { describe, expect, it } from 'vitest';
import { parseCursorStreamLine } from './cursorStreamParser.js';

describe('parseCursorStreamLine', () => {
  it('解析 assistant 与 result', () => {
    const state = { sessionId: '' };
    parseCursorStreamLine('{"type":"system","subtype":"init","session_id":"abc-123"}', state);
    expect(state.sessionId).toBe('abc-123');

    const thinking = parseCursorStreamLine(
      '{"type":"thinking","subtype":"delta","text":"hmm","session_id":"abc-123"}',
      state,
    );
    expect(thinking).toEqual([{ kind: 'thought', sessionId: 'abc-123', text: 'hmm' }]);

    const assistant = parseCursorStreamLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]},"session_id":"abc-123"}',
      state,
    );
    expect(assistant).toEqual([{ kind: 'message', sessionId: 'abc-123', text: 'Hi' }]);

    const end = parseCursorStreamLine(
      '{"type":"result","subtype":"success","session_id":"abc-123","duration_ms":100}',
      state,
    );
    expect(end.some((e) => e.kind === 'turn_end')).toBe(true);
  });
});

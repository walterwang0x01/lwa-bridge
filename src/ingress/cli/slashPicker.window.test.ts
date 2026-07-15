import { describe, expect, it } from 'vitest';
import { windowStart } from './slashPicker.js';
import { decodeModelPick, encodeModelPick } from './modelPicker.js';

describe('windowStart', () => {
  it('keeps selection visible in a sliding window', () => {
    expect(windowStart(0, 40, 10)).toBe(0);
    expect(windowStart(5, 40, 10)).toBe(0);
    expect(windowStart(20, 40, 10)).toBeGreaterThan(0);
    expect(windowStart(39, 40, 10)).toBe(30);
  });
});

describe('modelPicker labels order helpers', () => {
  it('encodes engine vs kiro vs gateway distinctly', () => {
    expect(decodeModelPick(encodeModelPick({ kind: 'engine', name: 'cursor' }))).toEqual({
      kind: 'engine',
      name: 'cursor',
    });
    expect(
      decodeModelPick(
        encodeModelPick({ kind: 'openai-model', profile: 'openai-fast', model: 'x/y' }),
      ),
    ).toEqual({ kind: 'openai-model', profile: 'openai-fast', model: 'x/y' });
  });
});

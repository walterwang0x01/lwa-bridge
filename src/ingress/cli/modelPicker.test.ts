import { describe, expect, it } from 'vitest';
import { decodeModelPick, encodeModelPick, type ModelPick } from './modelPicker.js';

describe('modelPicker encode/decode', () => {
  it('roundtrips engine / kiro / openai picks', () => {
    const samples: ModelPick[] = [
      { kind: 'engine', name: 'auto' },
      { kind: 'engine', name: 'cursor' },
      { kind: 'kiro-model', name: 'claude-sonnet-4.6' },
      { kind: 'openai-model', profile: 'openai-fast', model: 'aws-bedrock/claude-haiku-4-5' },
    ];
    for (const s of samples) {
      expect(decodeModelPick(encodeModelPick(s))).toEqual(s);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { decodeSessionId, encodeSessionId } from './sessionId.js';

describe('sessionId', () => {
  it('encode 带 runtime 前缀', () => {
    expect(encodeSessionId('kiro-acp', 'sess_abc')).toBe('kiro-acp:sess_abc');
    expect(encodeSessionId('cursor-cli', 'uuid-1')).toBe('cursor-cli:uuid-1');
  });

  it('decode 匹配 kind', () => {
    expect(decodeSessionId('kiro-acp:sess_abc', 'kiro-acp')).toBe('sess_abc');
    expect(decodeSessionId('cursor-cli:uuid-1', 'cursor-cli')).toBe('uuid-1');
    expect(decodeSessionId('cursor-cli:uuid-1', 'kiro-acp')).toBeUndefined();
  });

  it('legacy 无前缀仅 kiro-acp 有效', () => {
    expect(decodeSessionId('sess_legacy', 'kiro-acp')).toBe('sess_legacy');
    expect(decodeSessionId('sess_legacy', 'cursor-cli')).toBeUndefined();
  });
});

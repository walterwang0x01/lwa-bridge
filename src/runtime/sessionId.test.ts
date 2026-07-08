import { describe, expect, it } from 'vitest';
import { decodeSessionId, encodeSessionId } from './sessionId.js';

describe('sessionId', () => {
  it('encode 带 runtime 前缀', () => {
    expect(encodeSessionId('kiro-cli-acp', 'sess_abc')).toBe('kiro-cli-acp:sess_abc');
    expect(encodeSessionId('cursor-agent-cli', 'uuid-1')).toBe('cursor-agent-cli:uuid-1');
  });

  it('decode 匹配 kind', () => {
    expect(decodeSessionId('kiro-cli-acp:sess_abc', 'kiro-cli-acp')).toBe('sess_abc');
    expect(decodeSessionId('cursor-agent-cli:uuid-1', 'cursor-agent-cli')).toBe('uuid-1');
    expect(decodeSessionId('cursor-agent-cli:uuid-1', 'kiro-cli-acp')).toBeUndefined();
  });

  it('legacy 无前缀仅 kiro-cli-acp 有效', () => {
    expect(decodeSessionId('sess_legacy', 'kiro-cli-acp')).toBe('sess_legacy');
    expect(decodeSessionId('sess_legacy', 'cursor-agent-cli')).toBeUndefined();
  });
});

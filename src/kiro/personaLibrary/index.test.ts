import { describe, it, expect } from 'vitest';
import { listPersonaLibrary } from './index.js';

describe('listPersonaLibrary', () => {
  it('返回两个默认角色，含 prompt 和 tools', () => {
    const lib = listPersonaLibrary();
    expect(lib).toHaveLength(2);
    const names = lib.map((e) => e.name).sort();
    expect(names).toEqual(['code-reviewer', 'customer-service']);
    for (const entry of lib) {
      expect(typeof entry.config.prompt).toBe('string');
      expect((entry.config.prompt as string).length).toBeGreaterThan(0);
      expect(Array.isArray(entry.config.tools)).toBe(true);
    }
  });
});

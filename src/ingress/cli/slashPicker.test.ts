import { describe, expect, it } from 'vitest';
import { listSlashCommands } from './slashPicker.js';

describe('slashPicker', () => {
  it('lists core slash commands for code mode', () => {
    const cmds = listSlashCommands('code');
    const names = cmds.map((c) => c.cmd);
    expect(names).toContain('/model');
    expect(names).toContain('/runtime');
    expect(names).toContain('/runtime auto');
    expect(names).toContain('/help');
    expect(cmds.find((c) => c.cmd === '/model')?.insert).toBe('/model');
  });
});

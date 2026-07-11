import { describe, expect, it } from 'vitest';
import { defaultWorktreeParent, WorktreeError, addWorktree } from './worktree.js';
import { join } from 'node:path';

describe('worktree helpers', () => {
  it('default parent is under repo .lwa-worktrees', () => {
    expect(defaultWorktreeParent('/tmp/myrepo')).toBe(join('/tmp/myrepo', '.lwa-worktrees'));
  });

  it('rejects bad names without touching git', () => {
    expect(() => addWorktree('/tmp', '../x')).toThrow(WorktreeError);
    expect(() => addWorktree('/tmp', 'has space')).toThrow(WorktreeError);
  });
});

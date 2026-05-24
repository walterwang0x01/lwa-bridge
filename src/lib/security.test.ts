// 三层访问控制 + DM 豁免 + 防自锁校验的单元测试
import { describe, it, expect } from 'vitest';
import { isUserAllowed, isAdmin, validateAccessChange } from './security.js';
import type { Config } from './config.js';

function makeConfig(overrides: Partial<Config['access']> = {}): Config {
  return {
    lark: { appId: 'cli_x', appSecret: 'x' },
    kiro: {
      binPath: 'kiro-cli',
      trustedTools: [],
      timeoutMs: 60_000,
      idleTimeoutMinutes: 5,
    },
    workspace: { defaultCwd: '/tmp', allowedRoots: ['/tmp'] },
    access: {
      allowedUsers: [],
      allowedChats: [],
      admins: [],
      ...overrides,
    },
    preferences: {
      requireMentionInGroup: true,
      cardUpdateIntervalMs: 800,
      logRetentionDays: 7,
    },
  };
}

describe('isUserAllowed', () => {
  it('全空配置 = 完全开放', () => {
    const cfg = makeConfig();
    expect(isUserAllowed('ou_a', 'oc_x', 'p2p', cfg)).toBe(true);
    expect(isUserAllowed('ou_a', 'oc_x', 'group', cfg)).toBe(true);
  });

  it('allowedUsers 不在 → 拦掉', () => {
    const cfg = makeConfig({ allowedUsers: ['ou_owner'] });
    expect(isUserAllowed('ou_intruder', 'oc_x', 'group', cfg)).toBe(false);
  });

  it('allowedUsers 在 → 放行', () => {
    const cfg = makeConfig({ allowedUsers: ['ou_owner'] });
    expect(isUserAllowed('ou_owner', 'oc_x', 'group', cfg)).toBe(true);
  });

  it('allowedChats 不在 → 拦掉（群聊）', () => {
    const cfg = makeConfig({ allowedChats: ['oc_team'] });
    expect(isUserAllowed('ou_a', 'oc_random', 'group', cfg)).toBe(false);
  });

  it('DM 永远豁免 chat allowlist', () => {
    const cfg = makeConfig({ allowedChats: ['oc_team'] });
    // 即使 chat 不在白名单，DM (p2p) 也要放行；否则管理员一旦把自己锁出去就没法 DM 改回来
    expect(isUserAllowed('ou_owner', 'oc_dm_id', 'p2p', cfg)).toBe(true);
  });

  it('DM 仍要受 user allowlist 限制', () => {
    const cfg = makeConfig({ allowedUsers: ['ou_owner'] });
    expect(isUserAllowed('ou_intruder', 'oc_dm', 'p2p', cfg)).toBe(false);
  });

  it('user + chat 都需通过', () => {
    const cfg = makeConfig({ allowedUsers: ['ou_a'], allowedChats: ['oc_team'] });
    expect(isUserAllowed('ou_a', 'oc_team', 'group', cfg)).toBe(true);
    expect(isUserAllowed('ou_b', 'oc_team', 'group', cfg)).toBe(false);
    expect(isUserAllowed('ou_a', 'oc_other', 'group', cfg)).toBe(false);
    // 但是 a 的 DM 可以通
    expect(isUserAllowed('ou_a', 'oc_other', 'p2p', cfg)).toBe(true);
  });
});

describe('isAdmin', () => {
  it('admins 空 = 所有人都是 admin', () => {
    expect(isAdmin('ou_anyone', makeConfig())).toBe(true);
  });
  it('admins 非空 = 只列出的人是 admin', () => {
    const cfg = makeConfig({ admins: ['ou_owner'] });
    expect(isAdmin('ou_owner', cfg)).toBe(true);
    expect(isAdmin('ou_other', cfg)).toBe(false);
  });
});

describe('validateAccessChange', () => {
  it('全空 next 总是合法（恢复全开放）', () => {
    const errors = validateAccessChange({
      submitterOpenId: 'ou_owner',
      next: { allowedUsers: [], allowedChats: [], admins: [] },
    });
    expect(errors).toEqual([]);
  });

  it('admins 非空 + submitter 不在 → 报错', () => {
    const errors = validateAccessChange({
      submitterOpenId: 'ou_owner',
      next: { allowedUsers: [], allowedChats: [], admins: ['ou_other'] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('admins');
  });

  it('admins 非空 + submitter 在 → 通过', () => {
    const errors = validateAccessChange({
      submitterOpenId: 'ou_owner',
      next: { allowedUsers: [], allowedChats: [], admins: ['ou_owner', 'ou_b'] },
    });
    expect(errors).toEqual([]);
  });

  it('allowedUsers 非空 + submitter 不在 → 报错', () => {
    const errors = validateAccessChange({
      submitterOpenId: 'ou_owner',
      next: { allowedUsers: ['ou_other'], allowedChats: [], admins: [] },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('allowedUsers');
  });

  it('allowedChats 不需要校验 submitter（DM 永远能进）', () => {
    const errors = validateAccessChange({
      submitterOpenId: 'ou_owner',
      next: { allowedUsers: [], allowedChats: ['oc_team'], admins: [] },
    });
    expect(errors).toEqual([]);
  });

  it('多重错误一起返回', () => {
    const errors = validateAccessChange({
      submitterOpenId: 'ou_owner',
      next: {
        allowedUsers: ['ou_other'],
        allowedChats: [],
        admins: ['ou_other'],
      },
    });
    expect(errors.length).toBe(2);
  });
});

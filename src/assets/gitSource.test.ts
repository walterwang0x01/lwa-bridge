// GitAssetSource 单元测试：用临时 git 仓库当远程 source，覆盖 sync 候选发现、
// install 的"已存在则跳过"、asset-installs.json 落盘。
//
// 涉及的路径常量（ASSET_SOURCES_DIR / ~/.kiro/skills / ~/.kiro/agents）都基于 homedir()，
// 必须在 import 模块前把 HOME 指向临时目录 → 动态 import。
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

const TMP = mkdtempSync(join(tmpdir(), 'lkb-gitsrc-test-'));
process.env['HOME'] = TMP;

// 远程"仓库"目录（本地 git init 模拟）
const skillRepo = join(TMP, 'remote-skill-repo');
const agentRepo = join(TMP, 'remote-agent-repo');

let store: typeof import('./store.js');
let gitSource: typeof import('./gitSource.js');

async function initGitRepo(dir: string, setup: () => void): Promise<void> {
  mkdirSync(dir, { recursive: true });
  setup();
  await execa('git', ['init'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'test'], { cwd: dir });
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-m', 'init'], { cwd: dir });
}

beforeAll(async () => {
  store = await import('./store.js');
  gitSource = await import('./gitSource.js');

  // skill 仓库：一个含 SKILL.md 的目录
  await initGitRepo(skillRepo, () => {
    const skillDir = join(skillRepo, 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: demo-skill', 'description: "演示技能"', '---', '# demo'].join('\n'),
    );
  });

  // agent 仓库：一个 Agent_Config JSON
  await initGitRepo(agentRepo, () => {
    writeFileSync(
      join(agentRepo, 'demo-agent.json'),
      JSON.stringify({ prompt: '演示角色的 prompt', tools: [] }),
    );
  });
});

describe('GitAssetSource', () => {
  it('sync 一个 skill source 能发现候选 skill', async () => {
    await store.addSource({ name: 'skill-src', gitUrl: skillRepo, kind: 'skill' });
    const candidates = await gitSource.syncSource('skill-src');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe('demo-skill');
    expect(candidates[0]?.isNew).toBe(true);
  });

  it('install 一个 skill 会复制到 ~/.kiro/skills 并写安装记录', async () => {
    const r = await gitSource.installAsset('skill-src', 'demo-skill');
    expect(r.installed).toBe(true);
    expect(existsSync(join(TMP, '.kiro', 'skills', 'demo-skill', 'SKILL.md'))).toBe(true);

    const installsRaw = readFileSync(join(TMP, '.lwa', 'asset-installs.json'), 'utf-8');
    const installs = JSON.parse(installsRaw) as {
      installs: Array<{ assetId: string; sourceGitUrl: string }>;
    };
    const rec = installs.installs.find((i) => i.assetId === 'demo-skill');
    expect(rec).toBeDefined();
    expect(rec?.sourceGitUrl).toBe(skillRepo);
  });

  it('重复 install 已存在的 skill 返回 installed:false，不覆盖', async () => {
    const r = await gitSource.installAsset('skill-src', 'demo-skill');
    expect(r.installed).toBe(false);
    expect(r.reason).toContain('已存在');
  });

  it('sync 一个 agent source 能发现候选 agent', async () => {
    await store.addSource({ name: 'agent-src', gitUrl: agentRepo, kind: 'agent' });
    const candidates = await gitSource.syncSource('agent-src');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe('demo-agent');
  });

  it('install 一个 agent 会复制到 ~/.kiro/agents/<name>.json', async () => {
    const r = await gitSource.installAsset('agent-src', 'demo-agent');
    expect(r.installed).toBe(true);
    expect(existsSync(join(TMP, '.kiro', 'agents', 'demo-agent.json'))).toBe(true);
  });

  it('sync 不存在的 source 抛错', async () => {
    await expect(gitSource.syncSource('nonexistent')).rejects.toThrow();
  });
});

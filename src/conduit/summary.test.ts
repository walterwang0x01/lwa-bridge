/**
 * 复现：lwa-conduit CLI 有一个"裸重跑守卫"——发现上次有已完成任务、但这次
 * 既没 --resume 也没 --fresh 时会直接拒绝执行（退出码 1），stdout 打印一句
 * 固定的中文提示（"发现上次运行的进度..."）。bridge 需要识别这个场景并给出
 * 专门的引导（指向 /conduit run --resume / --fresh），而不是把它当成
 * "任务真的跑了、但部分失败"这种通用失败场景处理——两者的用户体验应该不同。
 */
describe('isBareRerunGuardResult', () => {
  const base = { ok: false, notFound: false, aborted: false, timedOut: false, output: '' };

  it('recognizes the bare-rerun guard message', () => {
    expect(
      isBareRerunGuardResult({
        ...base,
        output: '\n✗ 发现上次运行的进度（2 个 task 已完成）。\n  --resume 从断点续跑...',
      }),
    ).toBe(true);
  });

  it('returns false for a normal task-failure result (ran but some tasks failed)', () => {
    expect(isBareRerunGuardResult({ ...base, output: 'task=foo FAILED on attempt 2' })).toBe(false);
  });

  it('returns false when the run actually succeeded', () => {
    expect(isBareRerunGuardResult({ ...base, ok: true, output: '' })).toBe(false);
  });

  it('returns false when lwa-conduit is not installed', () => {
    expect(isBareRerunGuardResult({ ...base, notFound: true })).toBe(false);
  });

  it('returns false when the run was aborted or timed out', () => {
    expect(isBareRerunGuardResult({ ...base, aborted: true })).toBe(false);
    expect(isBareRerunGuardResult({ ...base, timedOut: true })).toBe(false);
  });
});
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findConduitDagPath,
  formatRunSummary,
  isBareRerunGuardResult,
  resolveConduitWorkspaceDir,
  summarizeRunState,
} from './summary.js';

const TMP = mkdtempSync(join(tmpdir(), 'lwa-conduit-summary-'));

beforeAll(() => {
  const dir = join(TMP, '.lwa-conduit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'run-state.json'),
    JSON.stringify({
      version: 1,
      base_branch: 'main',
      tasks: {
        a: { status: 'passed', branch: 'lwa-conduit/a', attempts: 1 },
        b: { status: 'failed', branch: 'lwa-conduit/b', attempts: 3 },
        c: { status: 'skipped' },
      },
    }),
  );
  writeFileSync(join(dir, 'review.md'), '# review\nverdict: PASS\n');
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('summarizeRunState', () => {
  it('reads .lwa-conduit run-state and review', () => {
    const s = summarizeRunState(TMP);
    expect(s).not.toBeNull();
    expect(s!.passed).toEqual(['a']);
    expect(s!.failed).toEqual(['b']);
    expect(s!.skipped).toEqual(['c']);
    expect(s!.baseBranch).toBe('main');
    expect(s!.reviewSnippet).toContain('PASS');
    const text = formatRunSummary(s!);
    expect(text).toContain('lwa-conduit/a');
    expect(text).toContain('✅ 1');
  });

  it('falls back to .kiro-conduit', () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), 'lwa-conduit-legacy-'));
    try {
      const dir = join(legacyRoot, '.kiro-conduit');
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'run-state.json'),
        JSON.stringify({
          version: 1,
          base_branch: 'dev',
          tasks: { x: { status: 'passed', branch: 'kiro-conduit/x' } },
        }),
      );
      const s = summarizeRunState(legacyRoot);
      expect(s?.dirName).toBe('.kiro-conduit');
      expect(s?.passed).toEqual(['x']);
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});

/**
 * 复现（/conduit 分步引导的判断依据）：/conduit（无参数）需要区分"从未 plan
 * 过"和"已经 plan 好、等着 run"两种状态，给出不同的下一步提示，而不是每次
 * 都显示同一段静态说明。findConduitDagPath 就是这个判断的依据——检测默认
 * plan 输出目录 `.conduit-plan/dag.yaml`，或用户自己手写在 cwd 根目录的
 * `dag.yaml`。
 */
describe('findConduitDagPath', () => {
  it('returns null when neither dag.yaml location exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwa-conduit-dag-none-'));
    try {
      expect(findConduitDagPath(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds dag.yaml under the default /conduit plan output dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwa-conduit-dag-plan-'));
    try {
      const dir = join(root, '.conduit-plan');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'dag.yaml'), 'tasks: []\n');
      expect(findConduitDagPath(root)).toBe(join(dir, 'dag.yaml'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds a hand-written dag.yaml at the repo root', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwa-conduit-dag-root-'));
    try {
      writeFileSync(join(root, 'dag.yaml'), 'tasks: []\n');
      expect(findConduitDagPath(root)).toBe(join(root, 'dag.yaml'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * 复现（真实用 lwa-conduit CLI 端到端跑通后才发现的问题，不是代码推理）：
 * `lwa-conduit run --workspace <dir>` 要求 <dir> 是"直接包含 dag.yaml 的
 * 目录"，但 `/conduit plan` 默认把产出放在 `<cwd>/.conduit-plan/dag.yaml`。
 * 如果 `/conduit run` 直接把 cwd 传给 --workspace，会报
 * "no dag.yaml in workspace dir"——即使用户完全照着 plan 输出的提示操作
 * （"已生成 .conduit-plan/dag.yaml，用 /conduit run 执行"）也会失败。
 * resolveConduitWorkspaceDir 负责把 "dag.yaml 实际所在的目录" 解析出来，
 * 而不是想当然地假设就是 cwd。
 */
describe('resolveConduitWorkspaceDir', () => {
  it('returns the .conduit-plan directory when that is where dag.yaml lives', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwa-conduit-ws-plan-'));
    try {
      const dir = join(root, '.conduit-plan');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'dag.yaml'), 'tasks: []\n');
      expect(resolveConduitWorkspaceDir(root)).toBe(dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the repo root itself when dag.yaml is hand-written there', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwa-conduit-ws-root-'));
    try {
      writeFileSync(join(root, 'dag.yaml'), 'tasks: []\n');
      expect(resolveConduitWorkspaceDir(root)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when there is no dag.yaml anywhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwa-conduit-ws-none-'));
    try {
      expect(resolveConduitWorkspaceDir(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

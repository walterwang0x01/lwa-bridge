/**
 * Plan 模块单元测试
 *
 * 覆盖：
 * - types: schema 校验 / 进度计算 / 终态判断
 * - render: 各状态卡片元素生成
 * - source: 文件变化监听 + 原子写入 + 损坏文件容错
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

const TMP = mkdtempSync(join(tmpdir(), 'plan-test-'));
process.env['HOME'] = TMP;

const typesMod = await import('./types.js');
const renderMod = await import('./render.js');
const sourceMod = await import('./source.js');
const pathsMod = await import('../lib/paths.js');

const silentLogger = pino({ level: 'silent' });

async function waitFor<T>(
  getter: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = getter();
  while (Date.now() < deadline) {
    last = getter();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

describe('plan/types', () => {
  it('schema accepts a valid plan', () => {
    const r = typesMod.PlanSchema.safeParse({
      version: 1,
      chatId: 'oc_test',
      status: 'running',
      items: [{ id: 's1', title: 'do x', status: 'pending' }],
      createdAt: 1,
      updatedAt: 2,
    });
    expect(r.success).toBe(true);
  });

  it('schema rejects bad status', () => {
    const r = typesMod.PlanSchema.safeParse({
      chatId: 'oc_test',
      status: 'wat',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(r.success).toBe(false);
  });

  it('progress computes done+skipped over total', () => {
    const plan = typesMod.PlanSchema.parse({
      chatId: 'oc_test',
      status: 'running',
      items: [
        { id: '1', title: 'a', status: 'done' },
        { id: '2', title: 'b', status: 'skipped' },
        { id: '3', title: 'c', status: 'in_progress' },
        { id: '4', title: 'd', status: 'pending' },
      ],
      createdAt: 1,
      updatedAt: 2,
    });
    expect(typesMod.planProgress(plan)).toBe(0.5);
  });

  it('allSettled true only when every item terminal', () => {
    const base = (status: string) =>
      typesMod.PlanSchema.parse({
        chatId: 'oc_test',
        status: 'running',
        items: [{ id: '1', title: 'a', status }],
        createdAt: 1,
        updatedAt: 2,
      });
    expect(typesMod.planAllSettled(base('done'))).toBe(true);
    expect(typesMod.planAllSettled(base('skipped'))).toBe(true);
    expect(typesMod.planAllSettled(base('failed'))).toBe(true);
    expect(typesMod.planAllSettled(base('in_progress'))).toBe(false);
    expect(typesMod.planAllSettled(base('pending'))).toBe(false);
  });
});

describe('plan/render', () => {
  const buildPlan = (overrides: Partial<typesMod.Plan> = {}): typesMod.Plan =>
    typesMod.PlanSchema.parse({
      chatId: 'oc_test',
      status: 'running',
      title: '做 PPT',
      items: [
        { id: 's1', title: '写 HTML', status: 'done' },
        { id: 's2', title: 'chrome 截图', status: 'in_progress', detail: '截到 3/5 张' },
        { id: 's3', title: '上传飞书', status: 'pending' },
      ],
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    });

  it('shows progress (done+skipped / total) in header', () => {
    const els = renderMod.renderPlanElements(buildPlan());
    const md = (els[0] as { content: string }).content;
    expect(md).toContain('（1/3）');
    expect(md).toContain('做 PPT');
  });

  it('uses correct icons for each status', () => {
    const els = renderMod.renderPlanElements(buildPlan());
    const md = (els[0] as { content: string }).content;
    expect(md).toContain('✅ 写 HTML');
    expect(md).toContain('⏳ chrome 截图');
    expect(md).toContain('☐ 上传飞书');
  });

  it('shows in_progress detail inline', () => {
    const els = renderMod.renderPlanElements(buildPlan());
    const md = (els[0] as { content: string }).content;
    expect(md).toContain('截到 3/5 张');
  });

  it('completed status uses ✅ icon in header', () => {
    const plan = buildPlan({
      status: 'completed',
      items: [
        { id: 's1', title: 'a', status: 'done' },
        { id: 's2', title: 'b', status: 'done' },
      ],
    });
    const els = renderMod.renderPlanElements(plan);
    const md = (els[0] as { content: string }).content;
    expect(md).toContain('✅ 任务计划');
  });

  it('failed status uses ❌ icon', () => {
    const plan = buildPlan({
      status: 'failed',
      items: [{ id: 's1', title: 'a', status: 'failed', detail: 'boom' }],
    });
    const els = renderMod.renderPlanElements(plan);
    const md = (els[0] as { content: string }).content;
    expect(md).toContain('❌ 任务计划');
    expect(md).toContain('boom'); // failed 的 detail 也展开
  });

  it('empty plan returns empty array', () => {
    const plan = typesMod.PlanSchema.parse({
      chatId: 'oc_test',
      status: 'planning',
      items: [],
      createdAt: 1,
      updatedAt: 2,
    });
    expect(renderMod.renderPlanElements(plan)).toEqual([]);
  });

  it('shouldShowPlan returns false for undefined or empty items', () => {
    expect(renderMod.shouldShowPlan(undefined)).toBe(false);
    const empty = typesMod.PlanSchema.parse({
      chatId: 'x',
      status: 'planning',
      items: [],
      createdAt: 1,
      updatedAt: 2,
    });
    expect(renderMod.shouldShowPlan(empty)).toBe(false);
  });
});

describe('plan/source - FilePlanSource', () => {
  beforeEach(() => {
    pathsMod.ensureDataDirs();
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('emits initial plan if file exists at start', async () => {
    const chatId = 'oc_initial';
    const dir = sourceMod.planDirFor(chatId);
    mkdirSync(dir, { recursive: true });
    const filePath = sourceMod.planFilePathFor(chatId);
    writeFileSync(
      filePath,
      JSON.stringify(
        typesMod.PlanSchema.parse({
          chatId,
          status: 'running',
          items: [{ id: '1', title: 'x', status: 'pending' }],
          createdAt: 1,
          updatedAt: 2,
        }),
      ),
    );

    const updates: typesMod.Plan[] = [];
    const src = new sourceMod.FilePlanSource(chatId, silentLogger);
    await src.start((p) => updates.push(p));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.items[0]?.title).toBe('x');
    src.stop();
  });

  it('emits on file change after start', async () => {
    const chatId = 'oc_change';
    const dir = sourceMod.planDirFor(chatId);
    mkdirSync(dir, { recursive: true });
    const filePath = sourceMod.planFilePathFor(chatId);

    const updates: typesMod.Plan[] = [];
    const src = new sourceMod.FilePlanSource(chatId, silentLogger);
    await src.start((p) => updates.push(p));

    // 原子写入：tmp + rename
    const tmpPath = filePath + '.tmp';
    writeFileSync(
      tmpPath,
      JSON.stringify(
        typesMod.PlanSchema.parse({
          chatId,
          status: 'running',
          items: [{ id: '1', title: 'first', status: 'pending' }],
          createdAt: 1,
          updatedAt: 2,
        }),
      ),
    );
    renameSync(tmpPath, filePath);

    await waitFor(
      () => updates,
      (u) => u.length >= 1,
    );
    expect(updates[updates.length - 1]?.items[0]?.title).toBe('first');
    src.stop();
  });

  it('silently ignores malformed json', async () => {
    const chatId = 'oc_malformed';
    const dir = sourceMod.planDirFor(chatId);
    mkdirSync(dir, { recursive: true });
    const filePath = sourceMod.planFilePathFor(chatId);

    const updates: typesMod.Plan[] = [];
    const src = new sourceMod.FilePlanSource(chatId, silentLogger);
    await src.start((p) => updates.push(p));

    writeFileSync(filePath, '{not valid json');
    await new Promise((r) => setTimeout(r, 250));
    expect(updates).toHaveLength(0);
    src.stop();
  });

  it('silently ignores schema-invalid plan', async () => {
    const chatId = 'oc_badschema';
    const dir = sourceMod.planDirFor(chatId);
    mkdirSync(dir, { recursive: true });
    const filePath = sourceMod.planFilePathFor(chatId);

    const updates: typesMod.Plan[] = [];
    const src = new sourceMod.FilePlanSource(chatId, silentLogger);
    await src.start((p) => updates.push(p));

    writeFileSync(filePath, JSON.stringify({ chatId, status: 'WRONG_STATUS' }));
    await new Promise((r) => setTimeout(r, 250));
    expect(updates).toHaveLength(0);
    src.stop();
  });

  it('stop() prevents further updates', async () => {
    const chatId = 'oc_stop';
    const dir = sourceMod.planDirFor(chatId);
    mkdirSync(dir, { recursive: true });
    const filePath = sourceMod.planFilePathFor(chatId);

    const updates: typesMod.Plan[] = [];
    const src = new sourceMod.FilePlanSource(chatId, silentLogger);
    await src.start((p) => updates.push(p));
    src.stop();

    writeFileSync(
      filePath,
      JSON.stringify(
        typesMod.PlanSchema.parse({
          chatId,
          status: 'running',
          items: [{ id: '1', title: 'after-stop', status: 'pending' }],
          createdAt: 1,
          updatedAt: 2,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(updates).toHaveLength(0);
  });

  it('planFilePathFor / planDirFor sanitize chatId', () => {
    const dirty = 'oc_../etc/passwd';
    const dir = sourceMod.planDirFor(dirty);
    expect(dir).not.toContain('..');
    const file = sourceMod.planFilePathFor(dirty);
    expect(file).not.toContain('..');
  });
});

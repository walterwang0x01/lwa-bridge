// TaskHistoryStore 单元测试：add/listRecent、超容量环形覆盖、倒序展示。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'lkb-taskhistory-test-'));
process.env['HOME'] = TMP;

let TaskHistoryStore: typeof import('./taskHistory.js').TaskHistoryStore;

beforeAll(async () => {
  ({ TaskHistoryStore } = await import('./taskHistory.js'));
});

beforeEach(() => {
  rmSync(join(TMP, '.lark-kiro-bridge', 'task-history.json'), { force: true });
});

function makeRecord(taskId: string, finishedAt: number) {
  return {
    taskId,
    chatId: 'oc_1',
    cwd: '/tmp/proj',
    startedAt: finishedAt - 1000,
    finishedAt,
    terminal: 'done',
    promptPreview: `task ${taskId}`,
    toolCallCount: 2,
    artifacts: ['/tmp/proj/foo.ts'],
  };
}

describe('TaskHistoryStore', () => {
  it('add 后 listRecent 能读到，按时间倒序', async () => {
    const store = new TaskHistoryStore();
    await store.add(makeRecord('t1', 1000));
    await store.add(makeRecord('t2', 2000));
    const list = await store.listRecent();
    expect(list.map((r) => r.taskId)).toEqual(['t2', 't1']);
  });

  it('listRecent 支持 limit', async () => {
    const store = new TaskHistoryStore();
    await store.add(makeRecord('t1', 1000));
    await store.add(makeRecord('t2', 2000));
    await store.add(makeRecord('t3', 3000));
    const list = await store.listRecent(2);
    expect(list.map((r) => r.taskId)).toEqual(['t3', 't2']);
  });

  it('无记录时返回空数组', async () => {
    const store = new TaskHistoryStore();
    expect(await store.listRecent()).toEqual([]);
  });

  it('能聚合 runtime/model 指标', async () => {
    const store = new TaskHistoryStore();
    await store.add({
      ...makeRecord('t1', 1000),
      runtimeKind: 'cursor-agent-cli',
      model: 'Auto',
    });
    await store.add({
      ...makeRecord('t2', 2500),
      runtimeKind: 'cursor-agent-cli',
      model: 'Auto',
    });
    await store.add({
      ...makeRecord('t3', 4000),
      runtimeKind: 'kiro-cli-acp',
      model: 'claude-sonnet-5',
      terminal: 'error',
    });
    const rows = await store.summarizeRuntimeMetrics();
    expect(rows[0]).toMatchObject({
      runtimeKind: 'cursor-agent-cli',
      model: 'Auto',
      total: 2,
      success: 2,
      failed: 0,
    });
  });

  it('能给出保守的自适应建议', async () => {
    const store = new TaskHistoryStore();
    await store.add({
      ...makeRecord('t1', 1000),
      runtimeKind: 'kiro-cli-acp',
      model: 'claude-sonnet-5',
    });
    await store.add({
      ...makeRecord('t2', 2000),
      runtimeKind: 'kiro-cli-acp',
      model: 'claude-sonnet-5',
    });
    await store.add({
      ...makeRecord('t3', 3000),
      runtimeKind: 'kiro-cli-acp',
      model: 'claude-sonnet-5',
    });
    const rec = await store.recommendAdaptiveStrategy();
    expect(rec.preferredRuntimeKind).toBe('kiro-cli-acp');
    expect(rec.preferredModel).toBe('claude-sonnet-5');
    expect(rec.runtimeSuccessRate).toBe(1);
  });
});

// runConduit 单元测试：用可执行的 shell 脚本模拟 lwa-conduit 二进制，
// 覆盖退出码、abort 信号、notFound（未安装）、流式输出回调、输出截断、NDJSON 事件。
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConduit, conduitBin, withAutoEvents } from './runner.js';
import { CONDUIT_EVENT_SCHEMA } from './events.js';

const TMP = mkdtempSync(join(tmpdir(), 'lkb-conduit-test-'));
const FAKE_BIN_DIR = join(TMP, 'bin');
mkdirSync(FAKE_BIN_DIR, { recursive: true });

/** 写一个可执行的 shell 脚本充当假的 lwa-conduit 二进制。 */
function writeFakeBin(name: string, script: string): string {
  const p = join(FAKE_BIN_DIR, name);
  writeFileSync(p, `#!/bin/sh\n${script}`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

const originalEnv = process.env['LWA_CONDUIT_BIN'];
const originalLegacy = process.env['KIRO_CONDUIT_BIN'];

afterAll(() => {
  if (originalEnv === undefined) delete process.env['LWA_CONDUIT_BIN'];
  else process.env['LWA_CONDUIT_BIN'] = originalEnv;
  if (originalLegacy === undefined) delete process.env['KIRO_CONDUIT_BIN'];
  else process.env['KIRO_CONDUIT_BIN'] = originalLegacy;
  rmSync(TMP, { recursive: true, force: true });
});

describe('withAutoEvents', () => {
  it('appends --events ndjson for run', () => {
    expect(withAutoEvents(['run', '--workspace', '/x'])).toEqual([
      'run',
      '--workspace',
      '/x',
      '--events',
      'ndjson',
    ]);
  });

  it('does not touch plan or existing --events', () => {
    expect(withAutoEvents(['plan', '--spec', 'a.md', '--out', 'o'])).toEqual([
      'plan',
      '--spec',
      'a.md',
      '--out',
      'o',
    ]);
    expect(withAutoEvents(['run', '--events', 'none'])).toEqual(['run', '--events', 'none']);
  });
});

describe('conduitBin', () => {
  it('默认返回 "lwa-conduit"', () => {
    delete process.env['LWA_CONDUIT_BIN'];
    delete process.env['KIRO_CONDUIT_BIN'];
    expect(conduitBin()).toBe('lwa-conduit');
  });

  it('LWA_CONDUIT_BIN 环境变量能覆盖', () => {
    process.env['LWA_CONDUIT_BIN'] = '/custom/path/lwa-conduit';
    expect(conduitBin()).toBe('/custom/path/lwa-conduit');
    delete process.env['LWA_CONDUIT_BIN'];
  });

  it('KIRO_CONDUIT_BIN 作为旧名回退', () => {
    delete process.env['LWA_CONDUIT_BIN'];
    process.env['KIRO_CONDUIT_BIN'] = '/legacy/kiro-conduit';
    expect(conduitBin()).toBe('/legacy/kiro-conduit');
    delete process.env['KIRO_CONDUIT_BIN'];
  });
});

describe('runConduit', () => {
  it('退出码 0 → ok=true', async () => {
    const bin = writeFakeBin('ok.sh', 'echo "workspace: /tmp/foo"\nexit 0\n');
    process.env['LWA_CONDUIT_BIN'] = bin;
    const r = await runConduit(['run'], { cwd: TMP, autoEvents: false });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('workspace: /tmp/foo');
    expect(r.notFound).toBe(false);
    expect(r.aborted).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it('非 0 退出码 → ok=false，但不抛异常（reject: false 生效）', async () => {
    const bin = writeFakeBin('fail.sh', 'echo "some task failed" >&2\nexit 1\n');
    process.env['LWA_CONDUIT_BIN'] = bin;
    const r = await runConduit(['run'], { cwd: TMP, autoEvents: false });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('some task failed');
  });

  it('stdout 和 stderr 都被合并进 output（保留时序，用 all: true）', async () => {
    const bin = writeFakeBin(
      'mixed.sh',
      'echo "line-from-stdout"\necho "line-from-stderr" >&2\nexit 0\n',
    );
    process.env['LWA_CONDUIT_BIN'] = bin;
    const r = await runConduit(['run'], { cwd: TMP, autoEvents: false });
    expect(r.output).toContain('line-from-stdout');
    expect(r.output).toContain('line-from-stderr');
  });

  it('lwa-conduit 不在 PATH（ENOENT）时返回 notFound，不抛异常', async () => {
    process.env['LWA_CONDUIT_BIN'] = join(TMP, 'this-binary-does-not-exist');
    const r = await runConduit(['run'], { cwd: TMP, autoEvents: false });
    expect(r.notFound).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('uv tool install lwa-conduit');
  });

  it('AbortSignal 中止后真正终止子进程（不是"看起来中止但还在跑"）', async () => {
    const bin = writeFakeBin(
      'slow.sh',
      'trap \'kill "$child" 2>/dev/null; exit 0\' TERM INT\nsleep 10 &\nchild=$!\nwait "$child"\necho "should not reach here"\nexit 0\n',
    );
    process.env['LWA_CONDUIT_BIN'] = bin;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const start = Date.now();
    const r = await runConduit(['run'], {
      cwd: TMP,
      signal: controller.signal,
      autoEvents: false,
    });
    const elapsed = Date.now() - start;

    expect(r.aborted).toBe(true);
    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('onProgress 回调收到流式输出（每次 data 事件触发一次）', async () => {
    const bin = writeFakeBin(
      'stream.sh',
      'echo "chunk1"\nsleep 0.05\necho "chunk2"\nsleep 0.05\necho "chunk3"\nexit 0\n',
    );
    process.env['LWA_CONDUIT_BIN'] = bin;
    const progressCalls: string[] = [];
    const r = await runConduit(['run'], {
      cwd: TMP,
      autoEvents: false,
      onProgress: (info) => progressCalls.push(info.textTail),
    });
    expect(r.ok).toBe(true);
    expect(progressCalls.length).toBeGreaterThan(0);
    const last = progressCalls[progressCalls.length - 1] ?? '';
    expect(last).toContain('chunk1');
    expect(last).toContain('chunk3');
  });

  it('输出超过截断上限时保留尾部并标注省略', async () => {
    const bin = writeFakeBin(
      'long.sh',
      'for i in $(seq 1 500); do echo "line-$i-filler-text-to-pad-length"; done\necho "TAIL_MARKER_XYZ"\nexit 0\n',
    );
    process.env['LWA_CONDUIT_BIN'] = bin;
    const r = await runConduit(['run'], { cwd: TMP, autoEvents: false });
    expect(r.output).toContain('TAIL_MARKER_XYZ');
    expect(r.output).toContain('前文省略');
    expect(r.output).not.toContain('line-1-filler');
  });

  it('解析 NDJSON 事件并写入 progress，日志里不含事件行', async () => {
    const ev1 = JSON.stringify({
      schema: CONDUIT_EVENT_SCHEMA,
      type: 'WaveStarted',
      ts: 1,
      wave_index: 1,
      total_waves: 1,
      task_ids: ['t1'],
    });
    const ev2 = JSON.stringify({
      schema: CONDUIT_EVENT_SCHEMA,
      type: 'TaskFinished',
      ts: 2,
      task_id: 't1',
      attempt: 1,
      passed: true,
    });
    const bin = writeFakeBin(
      'events.sh',
      `echo "human log"\necho '${ev1}' >&2\necho '${ev2}' >&2\nexit 0\n`,
    );
    process.env['LWA_CONDUIT_BIN'] = bin;
    let lastProgressEventCount = 0;
    const r = await runConduit(['run'], {
      cwd: TMP,
      autoEvents: false,
      onProgress: (info) => {
        lastProgressEventCount = info.progress.eventCount;
      },
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('human log');
    expect(r.output).not.toContain('lwa.conduit.event');
    expect(r.progress?.eventCount).toBeGreaterThanOrEqual(2);
    expect(r.progress?.tasks.t1?.status).toBe('passed');
    expect(lastProgressEventCount).toBeGreaterThanOrEqual(2);
  });
});

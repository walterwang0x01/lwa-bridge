// runConduit 单元测试：用可执行的 shell 脚本模拟 kiro-conduit 二进制，
// 覆盖退出码、abort 信号、notFound（未安装）、流式输出回调、输出截断。
//
// 用真实子进程（不 mock execa）——这类 spawn/signal 转发的代码正是最容易被
// mock 掉真问题的地方（之前 bridge 侧就出过"卡片显示已中止但进程还在跑"的
// bug），跑真实进程才能验证 AbortSignal 真的转成了 SIGTERM。
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConduit, conduitBin } from './runner.js';

const TMP = mkdtempSync(join(tmpdir(), 'lkb-conduit-test-'));
const FAKE_BIN_DIR = join(TMP, 'bin');
mkdirSync(FAKE_BIN_DIR, { recursive: true });

/** 写一个可执行的 shell 脚本充当假的 kiro-conduit 二进制。 */
function writeFakeBin(name: string, script: string): string {
  const p = join(FAKE_BIN_DIR, name);
  writeFileSync(p, `#!/bin/sh\n${script}`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

const originalEnv = process.env['KIRO_CONDUIT_BIN'];

afterAll(() => {
  if (originalEnv === undefined) delete process.env['KIRO_CONDUIT_BIN'];
  else process.env['KIRO_CONDUIT_BIN'] = originalEnv;
  rmSync(TMP, { recursive: true, force: true });
});

describe('conduitBin', () => {
  it('默认返回 "kiro-conduit"', () => {
    delete process.env['KIRO_CONDUIT_BIN'];
    expect(conduitBin()).toBe('kiro-conduit');
  });

  it('KIRO_CONDUIT_BIN 环境变量能覆盖', () => {
    process.env['KIRO_CONDUIT_BIN'] = '/custom/path/kiro-conduit';
    expect(conduitBin()).toBe('/custom/path/kiro-conduit');
    delete process.env['KIRO_CONDUIT_BIN'];
  });
});

describe('runConduit', () => {
  it('退出码 0 → ok=true', async () => {
    const bin = writeFakeBin('ok.sh', 'echo "workspace: /tmp/foo"\nexit 0\n');
    process.env['KIRO_CONDUIT_BIN'] = bin;
    const r = await runConduit(['run'], { cwd: TMP });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('workspace: /tmp/foo');
    expect(r.notFound).toBe(false);
    expect(r.aborted).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it('非 0 退出码 → ok=false，但不抛异常（reject: false 生效）', async () => {
    const bin = writeFakeBin('fail.sh', 'echo "some task failed" >&2\nexit 1\n');
    process.env['KIRO_CONDUIT_BIN'] = bin;
    const r = await runConduit(['run'], { cwd: TMP });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('some task failed');
  });

  it('stdout 和 stderr 都被合并进 output（保留时序，用 all: true）', async () => {
    const bin = writeFakeBin(
      'mixed.sh',
      'echo "line-from-stdout"\necho "line-from-stderr" >&2\nexit 0\n',
    );
    process.env['KIRO_CONDUIT_BIN'] = bin;
    const r = await runConduit(['run'], { cwd: TMP });
    expect(r.output).toContain('line-from-stdout');
    expect(r.output).toContain('line-from-stderr');
  });

  it('kiro-conduit 不在 PATH（ENOENT）时返回 notFound，不抛异常', async () => {
    process.env['KIRO_CONDUIT_BIN'] = join(TMP, 'this-binary-does-not-exist');
    const r = await runConduit(['run'], { cwd: TMP });
    expect(r.notFound).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('uv tool install kiro-conduit');
  });

  it('AbortSignal 中止后真正终止子进程（不是"看起来中止但还在跑"）', async () => {
    // 脚本 sleep 10s，我们在 100ms 后 abort，验证 runConduit 在远早于 10s 时返回
    const bin = writeFakeBin('slow.sh', 'sleep 10\necho "should not reach here"\nexit 0\n');
    process.env['KIRO_CONDUIT_BIN'] = bin;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const start = Date.now();
    const r = await runConduit(['run'], { cwd: TMP, signal: controller.signal });
    const elapsed = Date.now() - start;

    expect(r.aborted).toBe(true);
    expect(r.ok).toBe(false);
    // 关键断言：必须远早于脚本的 10s sleep 结束，证明进程真的被杀了而不是等它跑完
    expect(elapsed).toBeLessThan(5000);
  });

  it('onProgress 回调收到流式输出（每次 data 事件触发一次）', async () => {
    const bin = writeFakeBin(
      'stream.sh',
      'echo "chunk1"\nsleep 0.05\necho "chunk2"\nsleep 0.05\necho "chunk3"\nexit 0\n',
    );
    process.env['KIRO_CONDUIT_BIN'] = bin;
    const progressCalls: string[] = [];
    const r = await runConduit(['run'], {
      cwd: TMP,
      onProgress: (tail) => progressCalls.push(tail),
    });
    expect(r.ok).toBe(true);
    expect(progressCalls.length).toBeGreaterThan(0);
    // 最后一次回调应该已经累积了全部输出
    const last = progressCalls[progressCalls.length - 1] ?? '';
    expect(last).toContain('chunk1');
    expect(last).toContain('chunk3');
  });

  it('输出超过截断上限时保留尾部并标注省略', async () => {
    const bin = writeFakeBin(
      'long.sh',
      // 生成一段远超 2500 字符截断上限的输出，且尾部带一个可辨识标记
      'for i in $(seq 1 500); do echo "line-$i-filler-text-to-pad-length"; done\necho "TAIL_MARKER_XYZ"\nexit 0\n',
    );
    process.env['KIRO_CONDUIT_BIN'] = bin;
    const r = await runConduit(['run'], { cwd: TMP });
    expect(r.output).toContain('TAIL_MARKER_XYZ');
    expect(r.output).toContain('前文省略');
    // 头部的 line-1 应该已经被截掉
    expect(r.output).not.toContain('line-1-filler');
  });
});

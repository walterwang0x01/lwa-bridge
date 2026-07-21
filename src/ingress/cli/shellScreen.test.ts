import { describe, expect, it, vi } from 'vitest';
import {
  contentBottomRow,
  inputPaneTopRow,
  inputRow,
  positiveOr,
  ShellScreen,
  statusRow,
  truncateToCols,
  visibleWidth,
} from './shellScreen.js';

describe('shellScreen', () => {
  it('visibleWidth strips ANSI', () => {
    expect(visibleWidth('\x1b[1mAuto\x1b[0m · 42%')).toBe('Auto · 42%'.length);
  });

  it('truncateToCols respects width', () => {
    const long = 'A'.repeat(100);
    expect(visibleWidth(truncateToCols(long, 20))).toBeLessThanOrEqual(20);
  });

  it('layout: content / adaptive input pane / status', () => {
    // 24 行默认布局：内容 1..22，单行输入 23，状态 24
    expect(contentBottomRow(24)).toBe(22);
    expect(inputPaneTopRow(24)).toBe(23);
    expect(inputRow(24)).toBe(23);
    expect(statusRow(24)).toBe(24);
    expect(statusRow(4)).toBe(4);
  });

  it('shouldUse on for code TTY; plain and CI disable', () => {
    const prevPlain = process.env['LWA_PLAIN_SHELL'];
    const prevCi = process.env['CI'];
    try {
      delete process.env['LWA_PLAIN_SHELL'];
      delete process.env['CI'];
      expect(ShellScreen.shouldUse({ isTty: true, mode: 'code' })).toBe(true);

      process.env['LWA_PLAIN_SHELL'] = '1';
      expect(ShellScreen.shouldUse({ isTty: true, mode: 'code' })).toBe(false);

      delete process.env['LWA_PLAIN_SHELL'];
      process.env['CI'] = 'true';
      expect(ShellScreen.shouldUse({ isTty: true, mode: 'code' })).toBe(false);
    } finally {
      if (prevPlain === undefined) delete process.env['LWA_PLAIN_SHELL'];
      else process.env['LWA_PLAIN_SHELL'] = prevPlain;
      if (prevCi === undefined) delete process.env['CI'];
      else process.env['CI'] = prevCi;
    }
  });

  it('LWA_FORCE_ALT_SHELL overrides a false-negative process.stdout.isTTY (PyCharm-style terminals)', () => {
    const prevForce = process.env['LWA_FORCE_ALT_SHELL'];
    const prevPlain = process.env['LWA_PLAIN_SHELL'];
    const prevCi = process.env['CI'];
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    try {
      delete process.env['LWA_PLAIN_SHELL'];
      delete process.env['CI'];
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

      delete process.env['LWA_FORCE_ALT_SHELL'];
      // 不传 isTty：模拟嵌入式终端把 process.stdout.isTTY 报告为假阴性的真实场景。
      expect(ShellScreen.shouldUse({ mode: 'code' })).toBe(false);

      process.env['LWA_FORCE_ALT_SHELL'] = '1';
      expect(ShellScreen.shouldUse({ mode: 'code' })).toBe(true);
    } finally {
      if (isTtyDescriptor) Object.defineProperty(process.stdout, 'isTTY', isTtyDescriptor);
      if (prevForce === undefined) delete process.env['LWA_FORCE_ALT_SHELL'];
      else process.env['LWA_FORCE_ALT_SHELL'] = prevForce;
      if (prevPlain === undefined) delete process.env['LWA_PLAIN_SHELL'];
      else process.env['LWA_PLAIN_SHELL'] = prevPlain;
      if (prevCi === undefined) delete process.env['CI'];
      else process.env['CI'] = prevCi;
    }
  });

  it('docked mode uses alt-screen and paints status at bottom', () => {
    const chunks: string[] = [];
    const screen = new ShellScreen({
      docked: true,
      write: (s) => chunks.push(s),
      rows: 20,
      cols: 60,
    });
    screen.enter();
    expect(screen.isDocked).toBe(true);
    screen.renderBanner('code · multi-engine shell', '/help');
    screen.renderFooter({ primary: 'Auto · 1% · 0 files edited', approval: 'Run Everything' });
    screen.focusInput();
    screen.afterInput();
    screen.appendLine('hello');
    screen.redrawContent();
    screen.exit();
    const out = chunks.join('');
    expect(out).toContain('\x1b[?1049h');
    expect(out).toContain('LWA');
    expect(out).toContain('Auto · 1%');
    expect(out).toContain('Run Everything');
    expect(out).toContain('hello');
    expect(out).toContain('\x1b[?1049l');
    expect(out).toContain('\x1b[20;1H');
  });

  it('replaceLastBlock replaces stream patch without stacking', () => {
    const chunks: string[] = [];
    const screen = new ShellScreen({
      write: (s) => chunks.push(s),
      rows: 20,
      cols: 60,
      docked: true,
    });
    screen.enter();
    screen.appendBlock('v1\nline2');
    screen.replaceLastBlock('v2 only');
    screen.redrawContent();
    screen.exit();
    const out = chunks.join('');
    expect(out).toContain('v2 only');
    expect(out).not.toContain('v1');
    expect(out).not.toContain('line2');
  });

  /**
   * 复现（真实用户报告，2026-07-21）：命令响应内容写入后"不会自动吐字，
   * 要按其他键才触发吐字"。
   *
   * 根因：write() 写入内容后用 30ms 防抖 setTimeout 排队实际绘制
   * （scheduleContentRedraw）。suspendIngest(true) 内部会 cancelContentRedraw()
   * 取消任何排队中的重绘——这是为了防止"输入期间误写内容"设计的，但如果这次
   * 取消发生在一个尚未执行的 30ms 窗口内，且取消后没有人重新调度，内容就会
   * 被无限期地卡住不画，直到下一次操作重新触发 scheduleContentRedraw()。
   *
   * 真实时序：命令处理完写入结果（排队重绘）→ 主循环立刻进入下一轮
   * readLiveLine，其内部调用 suspendIngest(true) 为接收下一次按键做准备——
   * 这几乎是背靠背发生的，容易落在同一个 30ms 窗口内。
   */
  it('content written just before suspendIngest(true) must not be silently dropped', () => {
    vi.useFakeTimers();
    try {
      const chunks: string[] = [];
      const screen = new ShellScreen({
        write: (s) => chunks.push(s),
        rows: 20,
        cols: 60,
        docked: true,
      });
      screen.enter();
      chunks.length = 0; // 清掉 enter() 产生的初始画面，只看接下来这次写入

      // 模拟命令响应内容到达：appendBlock 内部 write() → scheduleContentRedraw()
      // 排队一个 30ms 后执行的重绘（尚未触发）。
      screen.appendBlock('conduit result: dag.yaml ready');

      // 紧接着（同一个 30ms 窗口内），下一轮 readLiveLine 调用 suspendIngest(true)
      // 为接收下一次按键做准备——真实代码路径：liveInput.ts readLiveLine()。
      screen.suspendIngest(true);

      // 30ms 窗口过去了，取消掉的重绘定时器不会被任何人补上。
      vi.advanceTimersByTime(100);

      // 输入期结束（模拟用户还没按键，或者恰好没有触发新的重绘）。
      const outBeforeAnyKeypress = chunks.join('');
      expect(outBeforeAnyKeypress).toContain('conduit result: dag.yaml ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('content is bottom-aligned above the input pane', () => {
    const chunks: string[] = [];
    const screen = new ShellScreen({
      write: (s) => chunks.push(s),
      rows: 12,
      cols: 40,
      docked: true,
      inputPaneHeight: 3,
    });
    screen.enter();
    chunks.length = 0;
    screen.appendLine('only');
    screen.redrawContent();
    // 内容底行 = 12-3-1 = 8；短 transcript 应画在靠近第 8 行，而非第 1 行
    const out = chunks.join('');
    expect(out).toContain('\x1b[8;1H');
    expect(out).toContain('only');
    // 第 1 行应被清成空（贴底留白）
    expect(out).toContain('\x1b[1;1H\x1b[2K');
    screen.exit();
  });
});

/**
 * 复现：process.stdout.rows/columns 在部分终端环境下会上报为数字 0（而非
 * undefined/null），例如某些伪终端实现、SSH 会话刚建立时。ShellScreen 构造
 * 函数/enter()/resize 回调里原先用 `value ?? fallback`，这个写法只在 value 是
 * null/undefined 时才生效——0 会直接通过并成为 this.rows/this.cols，导致所有
 * 依赖行列数的布局计算（输入框位置、状态栏行、光标定位）全部失效，docked
 * 模式表现为界面完全无响应（截图现象：thinking 卡住不动，其实是从未正确渲染
 * 也从未正确接收按键）。positiveOr 同时防御 0、NaN 和 undefined/null。
 */
describe('positiveOr', () => {
  it('returns the value when it is a positive finite number', () => {
    expect(positiveOr(24, 999)).toBe(24);
    expect(positiveOr(1, 999)).toBe(1);
  });

  it('falls back when the value is 0 (not just null/undefined)', () => {
    expect(positiveOr(0, 24)).toBe(24);
  });

  it('falls back when the value is undefined', () => {
    expect(positiveOr(undefined, 80)).toBe(80);
  });

  it('falls back when the value is NaN or negative', () => {
    expect(positiveOr(Number.NaN, 24)).toBe(24);
    expect(positiveOr(-5, 24)).toBe(24);
  });
});

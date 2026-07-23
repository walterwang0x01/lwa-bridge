import { describe, expect, it, vi } from 'vitest';
import {
  clampScrollOffset,
  contentBottomRow,
  inputPaneTopRow,
  inputRow,
  layoutContentViewport,
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

  describe('layoutContentViewport scrollOffset', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`); // line0..line19

    it('scrollOffset=0 shows the most recent lines (existing behavior)', () => {
      const out = layoutContentViewport({ lines, height: 5, mode: 'conversation' });
      expect(out).toEqual(['line15', 'line16', 'line17', 'line18', 'line19']);
    });

    it('scrollOffset>0 shows an earlier window, shifted up by offset', () => {
      // offset=5：从底部往上翻 5 行 → 窗口结束于 line14（倒数第 6 行）
      const out = layoutContentViewport({
        lines,
        height: 5,
        mode: 'conversation',
        scrollOffset: 5,
      });
      expect(out).toEqual(['line10', 'line11', 'line12', 'line13', 'line14']);
    });

    it('scrollOffset reaching the very start pads with empty lines, not out-of-range slices', () => {
      const out = layoutContentViewport({
        lines,
        height: 5,
        mode: 'conversation',
        scrollOffset: 19,
      });
      // end = 20-19=1 → 只有 line0 可见，其余用空行垂直填充在顶部
      expect(out).toEqual(['', '', '', '', 'line0']);
    });

    it('scrollOffset is ignored (clamped to 0 upstream) has no special-case in the pure fn itself', () => {
      // 纯函数本身不做上限收敛（由 clampScrollOffset 负责），但不能因超范围
      // offset 产生负数下标或抛异常。
      const out = layoutContentViewport({
        lines,
        height: 5,
        mode: 'conversation',
        scrollOffset: 999,
      });
      expect(out.every((l) => l === '')).toBe(true);
    });
  });

  describe('clampScrollOffset', () => {
    it('clamps to 0 when content fits within one screen (nothing to scroll)', () => {
      expect(clampScrollOffset(10, 10, 20)).toBe(0);
      expect(clampScrollOffset(10, 5, 20)).toBe(0);
    });

    it('clamps to the max offset (totalLines - height) when requesting further than history goes', () => {
      // 30 行历史，20 行高度 → 最多能翻 10 行（翻到第一屏刚好铺满开头）
      expect(clampScrollOffset(999, 30, 20)).toBe(10);
    });

    it('never returns negative even for negative input', () => {
      expect(clampScrollOffset(-5, 30, 20)).toBe(0);
    });

    it('passes through a value within valid range unchanged', () => {
      expect(clampScrollOffset(4, 30, 20)).toBe(4);
    });
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

  describe('ShellScreen history scroll (PageUp/PageDown)', () => {
    function makeDockedScreen(rows = 10, cols = 40) {
      const chunks: string[] = [];
      const screen = new ShellScreen({ write: (s) => chunks.push(s), rows, cols, docked: true });
      screen.enter();
      chunks.length = 0;
      return { screen, chunks };
    }

    it('isScrolled is false by default; scrollUp makes it true when there is history to see', () => {
      const { screen } = makeDockedScreen(10);
      // 内容区高度 = 10-1-1 = 8；写入 20 行，超出一屏才有可翻的历史。
      for (let i = 0; i < 20; i++) screen.appendLine(`line${i}`);
      expect(screen.isScrolled).toBe(false);
      screen.scrollUp();
      expect(screen.isScrolled).toBe(true);
    });

    it('scrollUp does nothing when all content already fits on one screen', () => {
      const { screen } = makeDockedScreen(10);
      screen.appendLine('only one line');
      screen.scrollUp();
      expect(screen.isScrolled).toBe(false);
    });

    it('scrollUp reveals earlier lines; scrollDown moves back toward the latest', () => {
      const { screen, chunks } = makeDockedScreen(10, 40);
      for (let i = 0; i < 30; i++) screen.appendLine(`line${i}`);
      chunks.length = 0;

      screen.scrollUp();
      const afterUp = chunks.join('');
      // 往上翻一页后，屏幕上不应再包含最新的 line29
      expect(afterUp).not.toContain('line29');
      expect(screen.isScrolled).toBe(true);

      chunks.length = 0;
      screen.scrollDown();
      screen.scrollDown();
      screen.scrollDown();
      screen.scrollDown();
      screen.scrollDown();
      // 翻回底部后应恢复自动跟随，isScrolled 变回 false
      expect(screen.isScrolled).toBe(false);
    });

    it('scrollToBottom immediately returns to isScrolled=false and clears the unseen flag', () => {
      const { screen } = makeDockedScreen(10);
      for (let i = 0; i < 30; i++) screen.appendLine(`line${i}`);
      screen.scrollUp();
      expect(screen.isScrolled).toBe(true);
      screen.scrollToBottom();
      expect(screen.isScrolled).toBe(false);
      expect(screen.hasUnseenContent).toBe(false);
    });

    it('new content while scrolled does not jump the view or interrupt reading; flags hasUnseenContent', () => {
      const { screen, chunks } = makeDockedScreen(10, 40);
      for (let i = 0; i < 30; i++) screen.appendLine(`line${i}`);
      screen.scrollUp(); // 翻到较早的一页
      chunks.length = 0;
      const viewBeforeNewContent = screen.debugTranscriptLines().slice(0, 5);

      expect(screen.hasUnseenContent).toBe(false);
      screen.appendLine('brand-new-message'); // 模拟新命令响应到达

      // 仍然处于滚动状态，没有被新内容打断拉回底部
      expect(screen.isScrolled).toBe(true);
      // 有新消息到达但未显示的标记应该被设置
      expect(screen.hasUnseenContent).toBe(true);
      // 新内容本身不应该出现在当前渲染的屏幕上（因为用户在看更早的历史）
      const afterNewContent = chunks.join('');
      expect(afterNewContent).not.toContain('brand-new-message');
      // 用户之前正在看的那批历史内容，viewport 里对应的原始行不变
      // （scrollOffset 同步递增保证了视觉内容不跳动）。
      expect(screen.debugTranscriptLines().slice(0, 5)).toEqual(viewBeforeNewContent);
    });

    it('scrolling back to bottom after missing content shows the latest and clears hasUnseenContent', () => {
      const { screen, chunks } = makeDockedScreen(10, 40);
      for (let i = 0; i < 30; i++) screen.appendLine(`line${i}`);
      screen.scrollUp();
      screen.appendLine('brand-new-message');
      expect(screen.hasUnseenContent).toBe(true);

      chunks.length = 0;
      screen.scrollToBottom();
      expect(screen.isScrolled).toBe(false);
      expect(screen.hasUnseenContent).toBe(false);
      const out = chunks.join('');
      expect(out).toContain('brand-new-message');
    });

    it('does not scroll while the welcome banner is showing (nothing meaningful to page through)', () => {
      const { screen } = makeDockedScreen(10);
      screen.renderBanner('code', '/help');
      screen.scrollUp();
      expect(screen.isScrolled).toBe(false);
    });
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

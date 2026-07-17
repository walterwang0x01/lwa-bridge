/**
 * 复现：docked（raw mode）模式下，终端/pty 会把多个按键合并进同一次 stdin
 * 'data' 事件（例如用户快速输入 "hi" 后立刻回车，到达时可能是整块 "hi\r"）。
 * 旧实现对整个 chunk 做单一按键的精确匹配，遇到混合了普通字符和控制字符的
 * chunk（如 "hi\r"）时既不匹配任何特殊键分支，也无法通过 isPrintableInput
 * 校验，导致整个 chunk 被静默丢弃——表现为用户提交消息后界面完全无响应
 * （截图现象：thinking 都不出现，因为回车本身都没被处理到）。
 * splitKeys 把合并 chunk 拆成独立的逻辑按键，交给现有的单键处理逻辑逐个处理。
 */
describe('splitKeys', () => {
  it('splits a plain-text-then-enter chunk into individual keys', () => {
    expect(splitKeys('hi\r')).toEqual(['h', 'i', '\r']);
  });

  it('keeps a lone control character as a single key', () => {
    expect(splitKeys('\r')).toEqual(['\r']);
    expect(splitKeys('\u0003')).toEqual(['\u0003']);
  });

  it('keeps a CSI arrow-key escape sequence as one token, not split byte-by-byte', () => {
    expect(splitKeys('\u001b[A')).toEqual(['\u001b[A']);
    expect(splitKeys('\u001b[B')).toEqual(['\u001b[B']);
  });

  it('handles an arrow key immediately followed by plain text in the same chunk', () => {
    expect(splitKeys('\u001b[Axy')).toEqual(['\u001b[A', 'x', 'y']);
  });

  it('does not split a multi-byte / surrogate-pair character (CJK, emoji)', () => {
    expect(splitKeys('你好')).toEqual(['你', '好']);
    expect(splitKeys('😀a')).toEqual(['😀', 'a']);
  });

  it('splits a backspace mixed into a text chunk', () => {
    expect(splitKeys('ab\x7f')).toEqual(['a', 'b', '\x7f']);
  });

  it('returns an empty array for an empty chunk', () => {
    expect(splitKeys('')).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  backspaceBuffer,
  buildInputPanePaint,
  filterSlashCommands,
  fitInputToCols,
  formatInputPaneDisplayLine,
  inputDisplayWidth,
  isPrintableInput,
  readLiveLine,
  simulateLiveInputKeys,
  splitKeys,
  suppressInputDuring,
  wrapInputPane,
} from './liveInput.js';
import { contentBottomRow, inputPaneTopRow } from './shellScreen.js';
import { listSlashCommands } from './slashPicker.js';

describe('liveInput printable / IME', () => {
  it('accepts single ASCII and CJK', () => {
    expect(isPrintableInput('a')).toBe(true);
    expect(isPrintableInput('是')).toBe(true);
  });

  it('accepts multi-char IME commit / paste', () => {
    expect(isPrintableInput('的是吗')).toBe(true);
    expect(isPrintableInput('你好世界')).toBe(true);
  });

  it('rejects controls and escapes', () => {
    expect(isPrintableInput('\u001b')).toBe(false);
    expect(isPrintableInput('\r')).toBe(false);
  });

  it('backspaces by unicode code point', () => {
    expect(backspaceBuffer('的是吗')).toBe('的是');
  });

  it('fits wide CJK into columns keeping the tail', () => {
    expect(inputDisplayWidth('是')).toBe(2);
    const fitted = fitInputToCols(2, '一二三四五六七八九十', 12);
    expect(fitted.startsWith('…')).toBe(true);
  });

  it('wrapInputPane keeps wrapped lines inside maxLines like Cursor box', () => {
    const long = '当前的项目是什么呀'.repeat(8);
    const w = wrapInputPane({
      promptPlain: '❯ ',
      buffer: long,
      cols: 20,
      maxLines: 3,
    });
    expect(w.lines.length).toBeLessThanOrEqual(3);
    expect(w.cursorLine).toBeGreaterThanOrEqual(0);
    expect(w.cursorLine).toBeLessThan(3);
  });
});

describe('liveInput filterSlashCommands', () => {
  const cmds = listSlashCommands('code');

  it('shows all on bare /', () => {
    expect(filterSlashCommands(cmds, '/').length).toBe(cmds.length);
  });

  it('filters by prefix', () => {
    const hit = filterSlashCommands(cmds, '/mo');
    expect(hit.some((c) => c.cmd === '/model')).toBe(true);
  });
});

describe('applyEnterKey backslash newline', () => {
  it('turns trailing \\ into newline', async () => {
    const { applyEnterKey } = await import('./liveInput.js');
    expect(applyEnterKey('哈哈哈\\')).toEqual({ next: '哈哈哈\n' });
    expect(applyEnterKey('ok')).toEqual({ submit: 'ok' });
    expect(applyEnterKey('a\\\\')).toEqual({ submit: 'a\\\\' });
  });

  it('wrapInputPane respects hard newlines', async () => {
    const { wrapInputPane } = await import('./liveInput.js');
    const w = wrapInputPane({
      promptPlain: '❯ ',
      buffer: '哈哈哈\n第二行',
      cols: 40,
      maxLines: 3,
    });
    expect(w.lines.length).toBeGreaterThanOrEqual(2);
    expect(w.lines.some((l) => l.includes('第二行'))).toBe(true);
  });

  it('desiredInputPaneHeight grows with lines', async () => {
    const { desiredInputPaneHeight } = await import('./liveInput.js');
    expect(desiredInputPaneHeight(1, 40)).toBe(1);
    expect(desiredInputPaneHeight(5, 40)).toBe(5);
    expect(desiredInputPaneHeight(20, 40)).toBeLessThanOrEqual(10);
  });

  it('scrolled pane lines do not keep prompt prefix', () => {
    const w = wrapInputPane({
      promptPlain: '❯ ',
      buffer: 'line1\nline2\nline3\nline4',
      cols: 40,
      maxLines: 2,
    });
    expect(w.totalLines).toBe(4);
    expect(w.lines[0]).toBe('line3');
    expect(w.lines[0]!.startsWith('❯ ')).toBe(false);
  });
});

describe('buildInputPanePaint multiline (screenshot scenario)', () => {
  it('backslash-enter keeps all lines in input pane above status', () => {
    const keys: Array<string | '\r'> = [];
    for (const ch of 'sssss\\') keys.push(ch);
    keys.push('\r');
    for (const ch of 'ssss\\') keys.push(ch);
    keys.push('\r');
    for (const ch of 'sssss\\') keys.push(ch);

    const { buffer } = simulateLiveInputKeys(keys);
    expect(buffer).toBe('sssss\nssss\nsssss\\');

    const paint = buildInputPanePaint({ buffer, cols: 80, termRows: 24 });
    expect(paint.pane).toBe(3);
    expect(paint.lines).toHaveLength(3);
    // 输入区在底栏上方（24 行终端：status=24, pane=3 → rows 21-23）
    expect(paint.lines[0]!.screenRow).toBe(inputPaneTopRow(24, 3));
    expect(paint.lines[2]!.screenRow).toBe(23);
    expect(paint.lines.every((l) => l.screenRow > contentBottomRow(24, 3))).toBe(true);
    // 仅首行有 prompt
    expect(paint.lines[0]!.plain.startsWith('❯ sssss')).toBe(true);
    expect(paint.lines[1]!.plain).toBe('  ssss');
    expect(paint.lines[2]!.plain).toBe('  sssss\\');
  });

  it('submit only on bare Enter and maps Ctrl+C to exit', () => {
    const { submitted } = simulateLiveInputKeys(['h', 'i', '\r']);
    expect(submitted).toBe('hi');
    const mid = simulateLiveInputKeys(['a', '\\', '\r', 'b']);
    expect(mid.buffer).toBe('a\nb');
    expect(mid.submitted).toBeUndefined();
    expect(simulateLiveInputKeys(['h', 'i', '\u0003']).submitted).toBe('.exit');
  });

  it('formatInputPaneDisplayLine indents continuations', () => {
    expect(formatInputPaneDisplayLine('❯ hi', '❯ ', '❯ ', 0)).toBe('❯ hi');
    expect(formatInputPaneDisplayLine('second', '❯ ', '❯ ', 1)).toBe('  second');
  });
});

/**
 * 复现：非 docked / 非 raw 兜底路径（PyCharm 内置终端等 process.stdout.isTTY 假阴性场景）下，
 * readLiveLine 退化为 rl.question(shellPrompt())；带 ANSI 颜色的 prompt 在部分终端里
 * 会让 readline 内部回显宽度计算错乱，产生类似 “/m> /> ,,,,ssss” 的拼接乱码。
 * 修复：fallback 分支改用纯文本 prompt（去除颜色转义），不影响 docked/raw 分支。
 */
describe('readLiveLine fallback prompt (non-raw terminals)', () => {
  it('passes a plain-text prompt (no ANSI escape codes) to fallbackAsk', async () => {
    let receivedPrompt = '';
    const result = await readLiveLine({
      shell: null,
      mode: 'code',
      fallbackAsk: async (p) => {
        receivedPrompt = p;
        return 'hello';
      },
    });
    expect(result).toBe('hello');
    expect(receivedPrompt.includes('\u001b[')).toBe(false);
    expect(receivedPrompt).toContain('❯');
  });

  it('leads with a blank line so each turn has a clear visual starting point', async () => {
    // 非 docked 简化模式没有清屏重绘能力；上一轮的回复、状态栏文字和新一轮的
    // 输入提示符如果紧贴在一起，用户很容易误以为程序完全没反应。
    let receivedPrompt = '';
    await readLiveLine({
      shell: null,
      mode: 'code',
      fallbackAsk: async (p) => {
        receivedPrompt = p;
        return 'hi';
      },
    });
    expect(receivedPrompt.startsWith('\n')).toBe(true);
  });

  it('still trims leading whitespace and trailing newlines from the fallback answer', async () => {
    const result = await readLiveLine({
      shell: null,
      mode: 'code',
      fallbackAsk: async () => '   /model\n\n',
    });
    expect(result).toBe('/model');
  });
});

/**
 * 复现（docked 模式）：readLiveLine 每次结束时把 stdin 还原成调用前的原始 raw
 * 状态（首次是 false），channel.ts 的 while 循环从 readLiveLine 返回到下一次
 * 调用之间要 await onMessage()（可能数十秒）。这段时间 stdin 处于非-raw 状态，
 * 终端会对用户按键做默认行缓冲和回显，直接写到 CliTurnView 用 \r 覆写的
 * thinking 动画所在行，产生 "thinking…> hi> > hi>" 拼接（截图复现的真实成因）。
 * suppressInputDuring 在任务执行期间保持 raw mode 并吞掉除 Ctrl+C 外的按键，
 * 同时临时移除 readline.Interface 挂在 stdin 上的 'keypress' 监听器（否则它
 * 会在 resume() 时抢先按非-raw 逻辑处理并回显第一个按键）。
 */
describe('suppressInputDuring', () => {
  function mockStdin(overrides: Partial<Record<string, unknown>> = {}) {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const stdin = {
      isRaw: false,
      setRawMode: vi.fn((v: boolean) => {
        stdin.isRaw = v;
      }),
      setEncoding: vi.fn(),
      resume: vi.fn(),
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
        return stdin;
      }),
      off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        const arr = listeners.get(event) ?? [];
        listeners.set(
          event,
          arr.filter((f) => f !== fn),
        );
        return stdin;
      }),
      removeListener: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        const arr = listeners.get(event) ?? [];
        listeners.set(
          event,
          arr.filter((f) => f !== fn),
        );
        return stdin;
      }),
      listeners: vi.fn((event: string) => [...(listeners.get(event) ?? [])]),
      emit(event: string, ...args: unknown[]) {
        for (const fn of listeners.get(event) ?? []) fn(...args);
      },
      ...overrides,
    };
    return stdin;
  }

  it('sets raw mode true during the task and restores the prior state after', async () => {
    const stdin = mockStdin();
    vi.stubGlobal('process', { ...process, stdin, pid: process.pid, kill: vi.fn() });
    const order: string[] = [];
    await suppressInputDuring(async () => {
      order.push('task');
      expect(stdin.isRaw).toBe(true);
    });
    expect(order).toEqual(['task']);
    expect(stdin.isRaw).toBe(false);
    vi.unstubAllGlobals();
  });

  it('removes keypress listeners during the task and restores them after', async () => {
    const keypressHandler = vi.fn();
    const stdin = mockStdin();
    stdin.on('keypress', keypressHandler);
    vi.stubGlobal('process', { ...process, stdin, pid: process.pid, kill: vi.fn() });

    let keypressCountDuringTask = -1;
    await suppressInputDuring(async () => {
      keypressCountDuringTask = stdin.listeners('keypress').length;
    });
    expect(keypressCountDuringTask).toBe(0);
    expect(stdin.listeners('keypress')).toEqual([keypressHandler]);
    vi.unstubAllGlobals();
  });

  it('calls onInterrupt when Ctrl+C is received during the task, without resolving early', async () => {
    const stdin = mockStdin();
    vi.stubGlobal('process', { ...process, stdin, pid: process.pid, kill: vi.fn() });
    const onInterrupt = vi.fn();
    let resolveTask: (() => void) | undefined;
    const taskPromise = suppressInputDuring(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
      { onInterrupt },
    );
    stdin.emit('data', '\u0003');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    resolveTask?.();
    await taskPromise;
    vi.unstubAllGlobals();
  });

  it('does not call onInterrupt for ordinary keys, and swallows them silently', async () => {
    const stdin = mockStdin();
    vi.stubGlobal('process', { ...process, stdin, pid: process.pid, kill: vi.fn() });
    const onInterrupt = vi.fn();
    await suppressInputDuring(
      async () => {
        stdin.emit('data', 'hi');
        stdin.emit('data', '\r');
      },
      { onInterrupt },
    );
    expect(onInterrupt).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

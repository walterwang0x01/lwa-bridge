import { describe, expect, it } from 'vitest';
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

import { describe, expect, it } from 'vitest';
import {
  contentBottomRow,
  inputPaneTopRow,
  inputRow,
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

  it('shouldUse on for code TTY; plain disables', () => {
    const prev = process.env['LWA_PLAIN_SHELL'];
    delete process.env['LWA_PLAIN_SHELL'];
    expect(ShellScreen.shouldUse({ isTty: true, mode: 'code' })).toBe(true);
    process.env['LWA_PLAIN_SHELL'] = '1';
    expect(ShellScreen.shouldUse({ isTty: true, mode: 'code' })).toBe(false);
    if (prev === undefined) delete process.env['LWA_PLAIN_SHELL'];
    else process.env['LWA_PLAIN_SHELL'] = prev;
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

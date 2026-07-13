import { describe, expect, it } from 'vitest';
import {
  formatShellFooterLines,
  scrollRegionBottom,
  ShellScreen,
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

  it('scrollRegionBottom reserves footer', () => {
    expect(scrollRegionBottom(24, 3)).toBe(20);
    expect(scrollRegionBottom(10, 3)).toBeGreaterThanOrEqual(3);
  });

  it('formatShellFooterLines builds three lines', () => {
    const lines = formatShellFooterLines(
      { primary: 'Auto · 10% · 0 files edited · Run Everything', secondary: '~/x · main' },
      40,
    );
    expect(lines.rule).toContain('─');
    expect(lines.primary).toContain('Auto');
    expect(lines.secondary).toContain('~/x');
  });

  it('ShellScreen.shouldUse is false by default (alt-screen opt-in)', () => {
    const prevAlt = process.env['LWA_ALT_SHELL'];
    const prevPlain = process.env['LWA_PLAIN_SHELL'];
    delete process.env['LWA_ALT_SHELL'];
    delete process.env['LWA_PLAIN_SHELL'];
    expect(ShellScreen.shouldUse({ isTty: true, mode: 'code' })).toBe(false);
    process.env['LWA_ALT_SHELL'] = '1';
    expect(ShellScreen.shouldUse({ isTty: true, mode: 'code' })).toBe(true);
    process.env['LWA_PLAIN_SHELL'] = '1';
    expect(ShellScreen.shouldUse({ isTty: true, mode: 'code' })).toBe(false);
    if (prevAlt === undefined) delete process.env['LWA_ALT_SHELL'];
    else process.env['LWA_ALT_SHELL'] = prevAlt;
    if (prevPlain === undefined) delete process.env['LWA_PLAIN_SHELL'];
    else process.env['LWA_PLAIN_SHELL'] = prevPlain;
  });

  it('appendLine writes through injectable writer', () => {
    const chunks: string[] = [];
    const screen = new ShellScreen({
      useAltScreen: false,
      write: (s) => chunks.push(s),
      rows: 20,
      cols: 60,
    });
    screen.enter();
    screen.appendLine('hello');
    screen.renderFooter({ primary: 'Auto · 1%', secondary: '~/p' });
    screen.exit();
    expect(chunks.join('')).toContain('hello\n');
    expect(chunks.join('')).toContain('Auto');
  });
});

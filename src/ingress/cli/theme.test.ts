import { describe, expect, it } from 'vitest';
import { displayWidth, stripAnsi } from './terminalWidth.js';
import {
  formatDockedStatusLine,
  formatInputPaneLine,
  formatShellBanner,
  formatShellStatusBlock,
  resolveThemeMode,
  shellPrompt,
} from './theme.js';

describe('theme Harbor', () => {
  it('renders a centered responsive LWA hero', () => {
    const banner = formatShellBanner({
      title: 'code · multi-engine shell',
      subtitle: 'Local agent workbench across Kiro, Cursor, and gateways',
      hint: 'Type / for commands',
      cols: 80,
      colored: false,
    });
    expect(banner).toContain('LWA');
    expect(banner).toContain('██');
    expect(banner).not.toContain('╭');
    expect(banner.split('\n').every((line) => displayWidth(line) <= 80)).toBe(true);
  });

  it('status block uses brand rail', () => {
    const status = formatShellStatusBlock('Auto · ctx 4%', '~/proj · main');
    expect(status).toContain('Auto · ctx 4%');
    expect(status).toContain('~/proj');
    expect(status).toContain('▌');
  });

  it('docked status puts approval on the right', () => {
    const line = formatDockedStatusLine({
      primary: 'Auto · ctx 4%',
      approval: 'Run Everything',
      cols: 72,
    });
    expect(line).toContain('Auto · ctx 4%');
    expect(line).toContain('Run Everything');
    expect(line).toContain('▌');
    expect(displayWidth(line)).toBeLessThanOrEqual(72);
  });

  it('docked status appends secondary when room', () => {
    const line = formatDockedStatusLine({
      primary: 'Auto · ctx 4%',
      secondary: '~/项目 · main · claude',
      approval: 'Run Everything',
      cols: 96,
    });
    expect(line).toContain('~/项目');
    expect(line).toContain('Run Everything');
    expect(displayWidth(line)).toBeLessThanOrEqual(96);
  });

  it('prompt is amber chevron not kiro arrow', () => {
    expect(shellPrompt()).toContain('❯');
    expect(shellPrompt()).not.toContain('→');
  });

  it('input pane line pads by display cells', () => {
    const line = formatInputPaneLine('❯ 你好', 20, { colored: false });
    expect(displayWidth(line)).toBe(20);
  });

  it('uses explicit light and dark surfaces', () => {
    const light = formatInputPaneLine('❯ hi', 20, { colored: true, theme: 'light' });
    const dark = formatInputPaneLine('❯ hi', 20, { colored: true, theme: 'dark' });
    expect(light).toContain('\x1b[48;2;248;250;252m');
    expect(dark).toContain('\x1b[48;2;23;31;42m');
    expect(stripAnsi(light)).toHaveLength(20);
    expect(stripAnsi(dark)).toHaveLength(20);
  });

  it('resolves explicit theme before COLORFGBG', () => {
    expect(resolveThemeMode({ LWA_THEME: 'dark', COLORFGBG: '0;15' })).toBe('dark');
    expect(resolveThemeMode({ COLORFGBG: '0;15' })).toBe('light');
  });
});

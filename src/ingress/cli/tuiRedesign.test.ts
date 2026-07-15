import { describe, expect, it } from 'vitest';
import { buildInputPanePaint, desiredInputPaneHeight } from './liveInput.js';
import { layoutContentViewport } from './shellScreen.js';
import {
  formatCliStatusPrimary,
  formatCliSubStatusLine,
  type CliStatusSnapshot,
} from './statusBar.js';
import { formatInputPaneLine, formatShellBanner, resolveThemeMode } from './theme.js';
import { displayWidth, padToDisplayWidth, stripAnsi, truncateDisplay } from './terminalWidth.js';

const statusBase: CliStatusSnapshot = {
  routeMode: 'Auto',
  engine: 'kiro',
  filesCount: 0,
  approval: 'Run Everything',
  cwd: '/tmp/lwa',
  branch: 'main',
  model: 'claude-test',
};

describe('TUI redesign contract', () => {
  it('measures graphemes, CJK, combining marks and emoji by terminal cells', () => {
    expect(displayWidth('A中👩‍💻e\u0301')).toBe(6);
    expect(displayWidth('🇨🇳')).toBe(2);
    expect(displayWidth('\x1b[1m你好\x1b[0m')).toBe(4);
    expect(truncateDisplay('你好世界', 5)).toBe('你好…');
    expect(displayWidth(padToDisplayWidth('中', 4))).toBe(4);
  });

  it('resolves explicit and terminal-derived light/dark themes', () => {
    expect(resolveThemeMode({ LWA_THEME: 'light' })).toBe('light');
    expect(resolveThemeMode({ LWA_THEME: 'dark' })).toBe('dark');
    expect(resolveThemeMode({ COLORFGBG: '0;15' })).toBe('light');
    expect(resolveThemeMode({ COLORFGBG: '15;0' })).toBe('dark');
  });

  it('uses distinct subtle input surfaces for light and dark terminals', () => {
    const light = formatInputPaneLine('❯ hello', 24, { colored: true, theme: 'light' });
    const dark = formatInputPaneLine('❯ hello', 24, { colored: true, theme: 'dark' });
    expect(light).not.toBe(dark);
    expect(light).not.toContain('\x1b[48;5;236m');
    expect(displayWidth(light)).toBe(24);
    expect(displayWidth(dark)).toBe(24);
  });

  it('renders a centered responsive brand hero without a small box', () => {
    const banner = formatShellBanner({
      title: 'code · multi-engine shell',
      subtitle: 'Local agent workbench across Kiro, Cursor, and gateways',
      hint: 'Type / for commands',
      cols: 80,
      colored: false,
    });
    const lines = banner.split('\n');
    expect(banner).toContain('██');
    expect(banner).not.toContain('╭');
    expect(lines.some((line) => line.startsWith('          '))).toBe(true);
    expect(lines.every((line) => displayWidth(line) <= 80)).toBe(true);

    const narrow = formatShellBanner({
      title: 'code · multi-engine shell',
      subtitle: 'Local agent workbench across Kiro, Cursor, and gateways',
      hint: 'Type / for commands',
      cols: 40,
      colored: false,
    });
    expect(narrow).toContain('LWA');
    expect(narrow.split('\n').every((line) => displayWidth(line) <= 40)).toBe(true);
  });

  it('places the welcome hero in the upper third, then bottom-aligns conversation content', () => {
    const hero = ['LWA', '', 'Local agent workbench'];
    const welcome = layoutContentViewport({ lines: hero, height: 18, mode: 'welcome' });
    const firstHeroRow = welcome.findIndex((line) => line.includes('LWA'));
    expect(firstHeroRow).toBeGreaterThanOrEqual(3);
    expect(firstHeroRow).toBeLessThanOrEqual(6);

    const conversation = layoutContentViewport({
      lines: ['user', 'assistant'],
      height: 8,
      mode: 'conversation',
    });
    expect(conversation.slice(-2)).toEqual(['user', 'assistant']);
  });

  it('starts with one calm input row, shows a placeholder, and grows for multiline input', () => {
    expect(desiredInputPaneHeight(1, 40)).toBe(1);
    expect(desiredInputPaneHeight(4, 40)).toBe(4);

    const empty = buildInputPanePaint({ buffer: '', cols: 80, termRows: 24 });
    expect(empty.pane).toBe(1);
    expect(empty.lines[0]?.plain).toContain('Ask LWA to build, debug, or explain');
    expect(empty.cursor.col).toBe(3);

    const multiline = buildInputPanePaint({ buffer: '一行\n二行\n三行', cols: 80, termRows: 24 });
    expect(multiline.pane).toBe(3);
  });

  it('suppresses empty status metrics and avoids repeating the selected engine', () => {
    const primary = formatCliStatusPrimary(statusBase);
    const secondary = formatCliSubStatusLine(statusBase);
    expect(primary).toBe('Auto→kiro');
    expect(primary).not.toContain('—%');
    expect(primary).not.toContain('0 files');
    expect(secondary).toContain('/tmp/lwa');
    expect(secondary).toContain('main');
    expect(secondary).toContain('claude-test');
    expect(secondary).not.toContain('kiro');
  });

  it('keeps ANSI styling out of plain visual assertions', () => {
    expect(stripAnsi('\x1b[1mLWA\x1b[0m')).toBe('LWA');
  });
});

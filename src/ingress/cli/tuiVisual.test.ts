import { describe, expect, it } from 'vitest';
import { INPUT_PLACEHOLDER } from './liveInput.js';
import { layoutContentViewport } from './shellScreen.js';
import { formatDockedStatusLine, formatInputPaneLine, formatShellBanner } from './theme.js';
import { displayWidth, stripAnsi } from './terminalWidth.js';

function startupFrame(cols: number, rows: number): string[] {
  const banner = formatShellBanner({
    title: 'code · multi-engine shell',
    subtitle: 'Local agent workbench across Kiro, Cursor, and gateways',
    hint: 'Type / for commands · /help to get started',
    cols,
    colored: false,
  }).split('\n');
  const body = layoutContentViewport({ lines: banner, height: rows - 2, mode: 'welcome' });
  const input = formatInputPaneLine(`❯ ${INPUT_PLACEHOLDER}`, cols, { colored: false });
  const status = formatDockedStatusLine({
    primary: 'Auto→kiro · ctx 6%',
    secondary: '~/lwa-bridge · main · claude-test',
    approval: 'Run Everything',
    cols,
  });
  return [...body, input, status];
}

function visibleRows(frame: string[]): string {
  return frame
    .map((line, index) => ({ index: index + 1, line: stripAnsi(line).trimEnd() }))
    .filter(({ line }) => line.length > 0)
    .map(({ index, line }) => `${String(index).padStart(2, '0')}│${line}`)
    .join('\n');
}

function showAnsi(text: string): string {
  return text.replaceAll('\x1b', '<ESC>').replaceAll(' ', '·');
}

describe('TUI visual regression', () => {
  it.each([
    [40, 16],
    [80, 24],
    [120, 32],
  ] as const)('keeps startup composition balanced at %ix%i', (cols, rows) => {
    const frame = startupFrame(cols, rows);
    expect(frame).toHaveLength(rows);
    expect(frame.every((line) => displayWidth(line) <= cols)).toBe(true);
    expect(visibleRows(frame)).toMatchSnapshot();
  });

  it('keeps light and dark input surfaces visually distinct', () => {
    const surfaces = {
      light: showAnsi(formatInputPaneLine('❯ 你好 👩‍💻', 18, { colored: true, theme: 'light' })),
      dark: showAnsi(formatInputPaneLine('❯ 你好 👩‍💻', 18, { colored: true, theme: 'dark' })),
    };
    expect(surfaces).toMatchSnapshot();
  });

  it('keeps CJK paths and emoji inside terminal cell budgets', () => {
    const cols = 40;
    const lines = [
      ...formatShellBanner({
        title: '代码工作台',
        subtitle: '跨 Kiro、Cursor 与网关的本地智能工作台',
        hint: '输入 / 查看命令 👩‍💻',
        cols,
        colored: false,
      }).split('\n'),
      formatInputPaneLine('❯ 修复登录问题 👩‍💻', cols, { colored: false }),
      formatDockedStatusLine({
        primary: '自动→kiro · 上下文 42%',
        secondary: '~/项目/本地智能工作台 · 主分支',
        approval: '全部执行',
        cols,
      }),
    ];
    expect(lines.every((line) => displayWidth(line) <= cols)).toBe(true);
    expect(lines.map((line) => stripAnsi(line).trimEnd()).filter(Boolean)).toMatchSnapshot();
  });
});

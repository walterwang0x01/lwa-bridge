import { afterEach, describe, expect, it } from 'vitest';
import { ShellScreen } from './shellScreen.js';
import { filterSlashCommands, formatInputPaneDisplayLine, wrapInputPane } from './liveInput.js';
import { formatInputPaneLine, shellPrompt } from './theme.js';
import { listSlashCommands } from './slashPicker.js';
import { contentBottomRow, inputPaneTopRow } from './shellScreen.js';

/**
 * 复现用户截图：打 /model 时内容区叠出 `❯ /m ❯ /mo ❯ /mod…`
 * 根因是 stdout hook 把输入期绘画/回显写进 transcript。
 */
describe('ghost prompt regression (/model typing)', () => {
  const originals: Array<() => void> = [];

  afterEach(() => {
    while (originals.length) originals.pop()!();
  });

  it('does not ingest prompt paint into transcript while typing slash', () => {
    const chunks: string[] = [];
    const screen = new ShellScreen({
      rows: 24,
      cols: 80,
      docked: true,
      write: (s) => chunks.push(s),
    });
    screen.enter();
    screen.renderBanner('code', '/help');
    screen.suspendIngest(true);
    screen.suspendChromeRepaint(true);

    const allCmds = listSlashCommands('code');
    let buffer = '';
    const pane = 3;
    const rows = 24;
    const cols = 80;

    const paintInput = () => {
      const prompt = shellPrompt();
      const promptPlain = '❯ ';
      const wrapped = wrapInputPane({ promptPlain, buffer, cols, maxLines: pane });
      const top = inputPaneTopRow(rows, pane);
      screen.clearInputPane();
      for (let i = 0; i < pane; i++) {
        const text = formatInputPaneDisplayLine(wrapped.lines[i], promptPlain, prompt, i);
        screen.writePassthrough(
          `\x1b[${top + i};1H\x1b[2K${formatInputPaneLine(text, cols, { colored: true })}`,
        );
      }
    };

    const paintMenu = () => {
      const items = filterSlashCommands(allCmds, buffer);
      const bottom = contentBottomRow(rows, pane);
      const maxShow = Math.min(items.length, Math.max(3, bottom - 3));
      const show = items.slice(0, maxShow);
      const block = ['↑↓ · Tab', ...show.map((it, i) => (i === 0 ? `❯ ${it.cmd}` : `  ${it.cmd}`))];
      screen.setMenuOverlay(block);
      paintInput();
    };

    for (const ch of '/model') {
      buffer += ch;
      paintInput();
      paintMenu();
    }

    // 模拟误写进 stdout（readline echo / 漏网 paint）
    process.stdout.write('❯ /model');
    process.stdout.write('❯ /mode');
    process.stdout.write('❯ /mod');

    const lines = screen.debugTranscriptLines().join('\n');
    expect(lines).not.toMatch(/❯\s*\/mod/);
    expect(lines).not.toContain('/model');
    // banner 仍在
    expect(lines).toContain('LWA');

    screen.suspendIngest(false);
    screen.exit();
  });

  it('stdout hook without suspendIngest WOULD pollute (documents the bug class)', () => {
    const screen = new ShellScreen({
      rows: 24,
      cols: 80,
      docked: true,
      write: () => {},
    });
    screen.enter();
    // 故意不 suspendIngest —— 验证 hook 会把 CSI 剥掉后叠进 openLine
    process.stdout.write('\x1b[21;1H\x1b[2K❯ /m');
    process.stdout.write('\x1b[21;1H\x1b[2K❯ /mo');
    process.stdout.write('\x1b[21;1H\x1b[2K❯ /mod');
    const joined = screen.debugTranscriptLines().join('');
    expect(joined).toContain('❯ /m');
    expect(joined).toContain('❯ /mo');
    expect(joined).toContain('❯ /mod');
    screen.exit();
  });
});

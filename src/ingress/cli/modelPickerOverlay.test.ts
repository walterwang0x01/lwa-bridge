import { describe, expect, it } from 'vitest';
import { ShellScreen } from './shellScreen.js';

/**
 * 复现：/model 菜单有时不显示。
 * 根因：pickFromList 用 writePassthrough 直写菜单行，不经过 menuOverlay；
 * 若渲染菜单之后又有异步内容写入触发 ShellScreen 的 30ms 防抖重绘，
 * paintContentViewport 只知道 transcript + menuOverlay，会把手绘菜单整体覆盖清空。
 * 修复：pickFromList 渲染期间调用 shell.suspendIngest(true)，阻止后台写入
 * 触发新一轮防抖重绘；选择结束后统一 suspendIngest(false) 恢复。
 */
describe('menu overlay regression (/model picker sometimes invisible)', () => {
  it('background async writes during a hand-painted menu do NOT wipe it when ingest is suspended', async () => {
    const chunks: string[] = [];
    const screen = new ShellScreen({
      rows: 24,
      cols: 80,
      docked: true,
      write: (s) => chunks.push(s),
    });
    screen.enter();
    screen.renderBanner('code', '/help');

    // 模拟 handleModelCmdCli：先打印说明文字（触发一次 scheduleContentRedraw）
    screen.appendBlock('route: Auto\ncurrent engine: openai-strong');

    // pickFromList 渲染菜单前挂起摄入（本次修复）
    screen.suspendIngest(true);

    // 直接手绘菜单（模拟 pickFromList.render 的 writePassthrough）
    const menuRow = 10;
    screen.writePassthrough(`\x1b[${menuRow};1H\x1b[2K❯ Auto  · smart route`);

    chunks.length = 0; // 只关心菜单画完之后发生的写入

    // 渲染菜单之后，任何后台异步写入（比如 buildUnifiedModelPickerItems 内部日志）
    // 都不应该重新触发内容重绘去覆盖菜单。
    process.stdout.write('background gateway probe log line\n');

    // 等待超过 ShellScreen 的 30ms 防抖窗口，确认没有发生覆盖式重绘
    await new Promise((r) => setTimeout(r, 60));

    const repainted = chunks.some((c) => c.includes(`\x1b[${menuRow};1H`));
    expect(repainted).toBe(false);

    screen.suspendIngest(false);
    screen.exit();
  });

  it('without suspending ingest, a background write DOES trigger a viewport repaint (documents the bug)', async () => {
    const chunks: string[] = [];
    const screen = new ShellScreen({
      rows: 24,
      cols: 80,
      docked: true,
      write: (s) => chunks.push(s),
    });
    screen.enter();
    screen.renderBanner('code', '/help');
    screen.appendBlock('route: Auto\ncurrent engine: openai-strong');

    const menuRow = 10;
    screen.writePassthrough(`\x1b[${menuRow};1H\x1b[2K❯ Auto  · smart route`);

    chunks.length = 0;
    process.stdout.write('background gateway probe log line\n');
    await new Promise((r) => setTimeout(r, 60));

    const repainted = chunks.some((c) => c.includes(`\x1b[${menuRow};1H`));
    expect(repainted).toBe(true);

    screen.exit();
  });
});

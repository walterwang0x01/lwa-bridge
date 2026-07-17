import { describe, it, expect } from 'vitest';
import { CliTurnView, formatToolLineForTest } from './turnView.js';

describe('formatToolLineForTest', () => {
  it('includes command detail when present', () => {
    const line = formatToolLineForTest('Bash', 'completed', {
      title: 'Bash',
      rawInput: { command: 'ls -la src' },
    });
    expect(line).toContain('Bash');
    expect(line).toContain('ls -la src');
  });
});

describe('CliTurnView', () => {
  it('renders header, tools, message, and footer', () => {
    const chunks: string[] = [];
    const view = new CliTurnView({
      profileName: 'kiro',
      routeMode: 'Auto',
      model: 'claude-test',
      cwd: '/tmp/proj',
      isTty: false,
      write: (s) => chunks.push(s),
    });
    view.start();
    view.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'fs_read',
      status: 'in_progress',
      raw: { title: 'Read', rawInput: { path: 'README.md' } },
    });
    view.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'fs_read',
      status: 'completed',
      raw: { title: 'Read' },
    });
    view.onEvent({
      kind: 'message',
      sessionId: 's',
      text: 'Hello from agent',
    });
    const summary = view.end();
    const out = chunks.join('');
    expect(out).toContain('Auto');
    expect(out).toContain('kiro');
    expect(out).toContain('claude-test');
    expect(out).toContain('Read');
    expect(out).toContain('Hello from agent');
    expect(out).toContain('done ·');
    expect(out).not.toContain('▶'); // Harbor 用竖轨，不用 kiro 式三角
    expect(summary.toolCount).toBe(1);
    expect(summary.messageChars).toBe('Hello from agent'.length);
  });

  it('uses textFallback when no streamed message', () => {
    const chunks: string[] = [];
    const view = new CliTurnView({
      profileName: 'cursor',
      cwd: '/x',
      isTty: false,
      write: (s) => chunks.push(s),
    });
    view.start();
    view.end({ textFallback: 'final only' });
    expect(chunks.join('')).toContain('final only');
  });

  /**
   * 复现（截图）：docked 模式（isTty: true，ToolPanel 走 compact 折叠展示）下，
   * 工具调用发生在文字回复之前时，运行中/完成状态行用 \r 原地刷新、不带换行；
   * 若消息事件到达时不做处理，会直接跟这行拼接，产生
   * "tools (2 done): tool · tool我是 **LWA**..." 这种一行堆在一起的乱码。
   */
  it('breaks the line between a compact tool summary and the message that follows it', () => {
    const chunks: string[] = [];
    const view = new CliTurnView({
      profileName: 'cursor',
      cwd: '/tmp/proj',
      isTty: true,
      write: (s) => chunks.push(s),
    });
    view.start();
    view.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'fs_read',
      status: 'completed',
      raw: { title: 'Read' },
    });
    view.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't2',
      name: 'fs_write',
      status: 'completed',
      raw: { title: 'Write' },
    });
    view.onEvent({
      kind: 'message',
      sessionId: 's',
      text: '我是 **LWA**',
    });
    const out = chunks.join('');
    // 工具摘要那一行的结尾必须换行，不能直接跟消息文字拼在同一行。
    const toolsLineIdx = out.indexOf('tools (');
    const messageIdx = out.indexOf('我是');
    expect(toolsLineIdx).toBeGreaterThanOrEqual(0);
    expect(messageIdx).toBeGreaterThan(toolsLineIdx);
    const between = out.slice(toolsLineIdx, messageIdx);
    expect(between).toContain('\n');
  });

  /**
   * 复现（真实 pty 测试发现的场景，比上一个测试更贴近实际）：AI 说一段话
   * → 中途调用工具 → 工具做完接着再说一段话。第一次修复只处理了
   * "messageStarted === false"（第一段消息之前）的情况，遗漏了这种"工具
   * 穿插在两段消息之间"的场景——此时 messageStarted 已经是 true，旧逻辑
   * 完全不会触发 breakOpenLine()，第二段消息文字照样跟工具摘要拼接。
   */
  it('breaks the line and re-adds the rail when tools interleave between two message segments', () => {
    const chunks: string[] = [];
    const view = new CliTurnView({
      profileName: 'cursor',
      cwd: '/tmp/proj',
      isTty: true,
      write: (s) => chunks.push(s),
    });
    view.start();
    view.onEvent({ kind: 'message', sessionId: 's', text: '先确认一下反馈通道。' });
    view.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'fs_read',
      status: 'completed',
      raw: { title: 'Read' },
    });
    view.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't2',
      name: 'fs_write',
      status: 'completed',
      raw: { title: 'Write' },
    });
    view.onEvent({ kind: 'message', sessionId: 's', text: '我是 **LWA**，本地编程助手。' });
    const out = chunks.join('');
    const toolsLineIdx = out.indexOf('tools (');
    const secondMessageIdx = out.indexOf('我是');
    expect(toolsLineIdx).toBeGreaterThanOrEqual(0);
    expect(secondMessageIdx).toBeGreaterThan(toolsLineIdx);
    const between = out.slice(toolsLineIdx, secondMessageIdx);
    expect(between).toContain('\n');
    // 第二段消息前必须重新出现消息轨道（▎），不能是跟在工具行后面的裸文本。
    expect(between).toContain('▎');
  });
});

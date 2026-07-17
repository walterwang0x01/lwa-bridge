import { describe, expect, it } from 'vitest';
import {
  formatToolRunningLine,
  formatToolSummaryLine,
  ToolPanel,
  toolDetailLabel,
} from './toolPanel.js';

describe('toolPanel', () => {
  it('toolDetailLabel extracts command', () => {
    const label = toolDetailLabel('Bash', { rawInput: { command: 'npm test' } });
    expect(label).toContain('Bash');
    expect(label).toContain('npm test');
  });

  it('formatToolRunningLine shows running count', () => {
    const line = formatToolRunningLine([
      { id: '1', name: 'Bash', status: 'in_progress', label: 'Bash' },
      { id: '2', name: 'Read', status: 'completed', label: 'Read' },
    ]);
    expect(line).toContain('running');
    expect(line).toContain('Bash');
  });

  it('formatToolSummaryLine collapses completed tools', () => {
    const line = formatToolSummaryLine([
      { id: '1', name: 'Bash', status: 'completed', label: 'Bash' },
      { id: '2', name: 'Read', status: 'completed', label: 'Read' },
    ]);
    expect(line).toContain('2 tool');
    expect(line).toContain('Bash');
    expect(line).toContain('Read');
  });

  it('formatToolSummaryLine uses label when name empty', () => {
    const line = formatToolSummaryLine([
      { id: '1', name: '', status: 'completed', label: 'Read src/cli.ts' },
      { id: '2', name: '', status: 'completed', label: 'Bash npm test' },
    ]);
    expect(line).toContain('Read');
    expect(line).toContain('Bash');
    expect(line).not.toMatch(/✓\s+·/);
  });

  it('ToolPanel finish writes summary in compact mode', () => {
    const chunks: string[] = [];
    const panel = new ToolPanel({ compact: true, write: (s) => chunks.push(s) });
    panel.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: '',
      status: 'completed',
      raw: { title: 'Bash', rawInput: { command: 'ls' } },
    });
    panel.finish();
    const out = chunks.join('');
    expect(out).toContain('▸');
    expect(out).toContain('Bash');
  });

  it('compact running line stays on openLine (no premature \\n)', () => {
    const chunks: string[] = [];
    const panel = new ToolPanel({ compact: true, write: (s) => chunks.push(s) });
    panel.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'Bash',
      status: 'in_progress',
      raw: {},
    });
    expect(chunks.join('')).not.toContain('\n');
    panel.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'Bash',
      status: 'in_progress',
      raw: {},
    });
    expect(chunks.some((c) => c.startsWith('\r'))).toBe(true);
    panel.finish();
    expect(chunks.join('')).toMatch(/\n$/);
  });

  /**
   * 复现：截图里 "tools (2 done): tool · tool我是 **LWA**..." ——工具调用穿插
   * 在文字回复之前（AI 先调用工具、再开始说话）时，compact 模式下 running/
   * done 状态行用 \r 原地刷新、不带换行（等 finish() 才统一提交换行）。若消息
   * 事件到达时直接开始写正文，会跟这行未提交的内容拼在一起。breakOpenLine()
   * 让当前行"定格"换行，不打印完整摘要、不清空条目，跟 finish() 的语义不同。
   */
  it('breakOpenLine commits the current running/done line without printing the final summary', () => {
    const chunks: string[] = [];
    const panel = new ToolPanel({ compact: true, write: (s) => chunks.push(s) });
    panel.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'Bash',
      status: 'completed',
      raw: {},
    });
    expect(panel.breakOpenLine()).toBe(true);
    const out = chunks.join('');
    expect(out).toMatch(/\n$/);
    // 不是最终汇总格式（不带 ▸ 符号），只是把 running/done 行收尾。
    expect(out).not.toContain('▸');
  });

  it('breakOpenLine is a no-op when there is no open line', () => {
    const chunks: string[] = [];
    const panel = new ToolPanel({ compact: true, write: (s) => chunks.push(s) });
    expect(panel.breakOpenLine()).toBe(false);
    expect(chunks.join('')).toBe('');
  });

  it('finish() after breakOpenLine still prints the final summary once', () => {
    const chunks: string[] = [];
    const panel = new ToolPanel({ compact: true, write: (s) => chunks.push(s) });
    panel.onEvent({
      kind: 'tool',
      sessionId: 's',
      toolCallId: 't1',
      name: 'Bash',
      status: 'completed',
      raw: {},
    });
    panel.breakOpenLine();
    panel.finish();
    const out = chunks.join('');
    const summaryOccurrences = out.split('▸').length - 1;
    expect(summaryOccurrences).toBe(1);
  });
});

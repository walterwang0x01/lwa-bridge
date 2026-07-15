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
});

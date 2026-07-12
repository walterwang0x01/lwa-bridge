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
    expect(out).toContain('kiro');
    expect(out).toContain('claude-test');
    expect(out).toContain('Read');
    expect(out).toContain('Hello from agent');
    expect(out).toContain('done ·');
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
});

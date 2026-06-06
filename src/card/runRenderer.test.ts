/**
 * runRenderer 关键终态渲染测试
 *
 * 覆盖：done / error / interrupted / idle_timeout / timeout 五种终态
 * 重点验证 timeout 终态：保留 blocks + 加"继续"按钮（P0 改动的核心收益）
 */
import { describe, it, expect } from 'vitest';
import { renderRunCard } from './runRenderer.js';
import type { RunState } from '../kiro/runState.js';

function stateOf(terminal: RunState['terminal'], blocks: RunState['blocks'] = []): RunState {
  return {
    blocks,
    reasoning: { content: '', active: false },
    terminal,
    footer: null,
  };
}

describe('renderRunCard', () => {
  it('done state: green template, no continue button', () => {
    const card = renderRunCard(stateOf('done', [{ kind: 'text', content: 'hi' }]));
    const json = JSON.stringify(card);
    expect(json).toContain('"green"');
    expect(json).not.toContain('session.continue');
  });

  it('error state: red template, no continue button', () => {
    const card = renderRunCard({
      ...stateOf('error'),
      errorMsg: 'boom',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('"red"');
    expect(json).toContain('boom');
    expect(json).not.toContain('session.continue');
  });

  it('interrupted state: orange template', () => {
    const card = renderRunCard(stateOf('interrupted'));
    const json = JSON.stringify(card);
    expect(json).toContain('"orange"');
    expect(json).not.toContain('session.continue');
  });

  it('idle_timeout state: red template, no continue button', () => {
    const card = renderRunCard({ ...stateOf('idle_timeout'), idleTimeoutMinutes: 3 });
    const json = JSON.stringify(card);
    expect(json).toContain('"red"');
    expect(json).toContain('3 分钟');
    expect(json).not.toContain('session.continue');
  });

  it('timeout state: yellow template + continue button + preserves blocks', () => {
    const blocks: RunState['blocks'] = [
      { kind: 'text', content: '已经做完了写 HTML 文件' },
      { kind: 'text', content: '正在用 chrome 截图...' },
    ];
    const card = renderRunCard(stateOf('timeout', blocks));
    const json = JSON.stringify(card);
    // 黄色头部 = 保留产出但需要后续动作的视觉信号
    expect(json).toContain('"yellow"');
    // 已完成的内容必须保留
    expect(json).toContain('已经做完了写 HTML 文件');
    expect(json).toContain('正在用 chrome 截图');
    // 必须有"继续"按钮
    expect(json).toContain('session.continue');
    // 标题里要有超时提示
    expect(json).toContain('超时');
  });

  it('running state: blue template + stop button', () => {
    const card = renderRunCard({ ...stateOf('running'), footer: 'thinking' });
    const json = JSON.stringify(card);
    expect(json).toContain('"blue"');
    expect(json).toContain('session.stop');
    expect(json).not.toContain('session.continue');
  });

  it('done state: 渲染 usage 行（credits / 上下文 / 耗时）', () => {
    const card = renderRunCard({
      ...stateOf('done', [{ kind: 'text', content: 'hi' }]),
      usage: { credits: 0.37, contextPercent: 12, turnDurationMs: 8054 },
    });
    const json = JSON.stringify(card);
    expect(json).toContain('credits');
    expect(json).toContain('上下文 12%');
    expect(json).toContain('8.1s');
  });

  it('上下文 >= 80% 时显示 /new 提醒', () => {
    const card = renderRunCard({
      ...stateOf('done', [{ kind: 'text', content: 'hi' }]),
      usage: { contextPercent: 85 },
    });
    expect(JSON.stringify(card)).toContain('/new');
  });

  it('running 态不渲染 usage 行（metadata 未完整）', () => {
    const card = renderRunCard({
      ...stateOf('running'),
      footer: 'streaming',
      usage: { credits: 0.1, contextPercent: 5 },
    });
    expect(JSON.stringify(card)).not.toContain('credits');
  });
});

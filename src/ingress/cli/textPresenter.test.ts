import { describe, expect, it } from 'vitest';
import { cardToPlainText, cleanCliText, formatCliHelp } from './textPresenter.js';

describe('textPresenter', () => {
  it('extracts markdown from ack-like card', () => {
    const card = {
      header: { title: { tag: 'plain_text', content: 'Status' } },
      body: {
        elements: [{ tag: 'markdown', content: 'cwd: `/tmp`\n💰 12 credits' }],
      },
    };
    const text = cardToPlainText(card);
    expect(text).toContain('Status');
    expect(text).toContain('cwd:');
    expect(text).not.toContain('💰');
  });

  it('formatCliHelp mentions Auto Shell and serve', () => {
    const h = formatCliHelp('code');
    expect(h).toContain('/runtime');
    expect(h).toContain('lwa serve');
    expect(h).toContain('Auto');
    expect(h).toContain('lwa code');
    expect(h).toContain('/yolo');
  });

  it('cleanCliText strips button chrome', () => {
    expect(cleanCliText('hello\n[ ⏹ 终止 ]\n')).toBe('hello');
  });
});

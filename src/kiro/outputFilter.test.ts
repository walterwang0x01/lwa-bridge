/**
 * createKiroOutputFilter 单元测试
 *
 * 这是状态机过滤器，覆盖：
 *   - 工具调用起始行的识别（多种 pattern）
 *   - 工具调用过程中裸输出被吞掉
 *   - "- Completed in" 退出 in-tool 状态
 *   - 静默行（Credits / Successfully / Purpose / WARNING）
 *   - "> 真实回复" 前缀去除
 *   - chunked feed + flush 的边界正确性
 *   - onTrace 回调与 inline 回退
 */
import { describe, it, expect, vi } from 'vitest';
import { createKiroOutputFilter } from './outputFilter.js';

describe('createKiroOutputFilter', () => {
  describe('detectToolStart 各种 pattern', () => {
    it('识别 Reading file 起始行', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('Reading file: /path/to/foo.md, all lines (using tool: read)\n');
      expect(out).toContain('📖 读取 foo.md');
    });

    it('识别 Writing file 起始行', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('Writing file: /tmp/bar.txt (using tool: write)\n');
      expect(out).toContain('✏️ 写入 bar.txt');
    });

    it('识别 I will run the following command', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('I will run the following command: ls -la (using tool: shell)\n');
      expect(out).toContain('⚙️ 运行');
      expect(out).toContain('ls -la');
    });

    it('识别 Searching for grep', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('Searching for `TODO` (using tool: grep)\n');
      expect(out).toContain('🔍 搜索');
      expect(out).toContain('TODO');
    });

    it('识别 Searching for glob', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('Searching for `*.ts` (using tool: glob)\n');
      expect(out).toContain('🔍 搜索');
    });

    it('通用兜底匹配 (using tool: xxx)', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('Doing something (using tool: code)\n');
      expect(out).toContain('⚙️ 调用 code');
    });

    it('不识别的普通行原样输出', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('just a plain line\n');
      expect(out).toBe('just a plain line\n');
    });

    it('长命令名被截断到 60 字符', () => {
      const f = createKiroOutputFilter();
      const longCmd = 'a'.repeat(80);
      const out = f.feed(`I will run the following command: ${longCmd} (using tool: shell)\n`);
      // 60 - 1 (省略号) = 59 个 a
      expect(out).toContain('a'.repeat(59) + '…');
      expect(out).not.toContain('a'.repeat(80));
    });
  });

  describe('in-tool 状态吃掉裸输出', () => {
    it('工具调用后续行被全部吞掉，直到 Completed in', () => {
      const f = createKiroOutputFilter();
      let out = '';
      out += f.feed('I will run the following command: cat foo (using tool: shell)\n');
      out += f.feed('line1 of cmd output\n');
      out += f.feed('{"key": "value"}\n');
      out += f.feed('line3\n');
      out += f.feed('- Completed in 0.5s\n');
      out += f.feed('back to normal\n');

      expect(out).toContain('⚙️ 运行');
      expect(out).not.toContain('line1 of cmd output');
      expect(out).not.toContain('{"key": "value"}');
      expect(out).not.toContain('line3');
      expect(out).not.toContain('Completed in 0.5s');
      expect(out).toContain('back to normal');
    });

    it('多次工具调用都能正确进入和退出 in-tool', () => {
      const f = createKiroOutputFilter();
      let out = '';
      out += f.feed('Reading file: /a.txt (using tool: read)\n');
      out += f.feed('garbage 1\n');
      out += f.feed('- Completed in 0.1s\n');
      out += f.feed('Writing file: /b.txt (using tool: write)\n');
      out += f.feed('garbage 2\n');
      out += f.feed('- Completed in 0.2s\n');

      expect(out).toContain('📖 读取 a.txt');
      expect(out).toContain('✏️ 写入 b.txt');
      expect(out).not.toContain('garbage');
    });
  });

  describe('isSilent 静默行', () => {
    it('丢弃 "✓ Successfully ..." 行', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('✓ Successfully read 100 bytes from /a\n');
      expect(out).toBe('');
    });

    it('丢弃 "▸ Credits: ..." 行', () => {
      const f = createKiroOutputFilter();
      const out = f.feed(' ▸ Credits: 0.12 • Time: 9s\n');
      expect(out).toBe('');
    });

    it('丢弃 "▶ Credits: ..." 行（注意半角符号）', () => {
      const f = createKiroOutputFilter();
      const out = f.feed(' ▶ Credits: 0.12\n');
      expect(out).toBe('');
    });

    it('丢弃 Purpose 行', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('Purpose: 演示用\n');
      expect(out).toBe('');
    });

    it('丢弃 WARNING 行', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('WARNING: trust-tools is set to all\n');
      expect(out).toBe('');
    });

    it('丢弃单独的 Completed in 行（非工具调用上下文也丢）', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('- Completed in 1.2s\n');
      expect(out).toBe('');
    });
  });

  describe('reply 前缀 ">"', () => {
    it('">" 后跟正文，去掉前缀', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('> hello world\n');
      expect(out).toBe('hello world\n');
    });

    it('单独的 ">" 输出空行', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('>\n');
      expect(out).toBe('\n');
    });

    it('普通 "> " 在多行回复中保持去前缀', () => {
      const f = createKiroOutputFilter();
      let out = '';
      out += f.feed('> 这是回复第一行\n');
      out += f.feed('> 第二行\n');
      expect(out).toBe('这是回复第一行\n第二行\n');
    });
  });

  describe('chunked feed 与 flush', () => {
    it('chunk 边界拆开一行也能正确处理', () => {
      const f = createKiroOutputFilter();
      let out = '';
      out += f.feed('Reading file: /pa');
      out += f.feed('th/x.md (using tool: read)\n');
      expect(out).toContain('📖 读取 x.md');
    });

    it('flush 处理最后一行无换行的情况', () => {
      const f = createKiroOutputFilter();
      f.feed('hello');
      const out = f.flush();
      expect(out).toContain('hello');
    });

    it('flush 在 buffer 为空时返回空串', () => {
      const f = createKiroOutputFilter();
      expect(f.flush()).toBe('');
    });
  });

  describe('onTrace 回调', () => {
    it('提供 onTrace 时，工具摘要走回调而非 inline', () => {
      const onTrace = vi.fn();
      const f = createKiroOutputFilter({ onTrace });
      const out = f.feed('Reading file: /a.md (using tool: read)\n');
      expect(out).toBe('');
      expect(onTrace).toHaveBeenCalledOnce();
      expect(onTrace).toHaveBeenCalledWith('📖 读取 a.md');
    });

    it('未提供 onTrace 时，工具摘要 inline 输出', () => {
      const f = createKiroOutputFilter();
      const out = f.feed('Reading file: /a.md (using tool: read)\n');
      expect(out).toBe('📖 读取 a.md\n');
    });
  });

  describe('完整真实场景重放', () => {
    it('典型 kiro-cli 输出：工具调用 + 回复 + Credits', () => {
      const f = createKiroOutputFilter();
      const raw = [
        'Reading file: /Users/me/x.md, all lines (using tool: read)',
        '✓ Successfully read 100 bytes from /Users/me/x.md',
        '- Completed in 0.0s',
        '',
        '> 这是 LLM 的回复',
        '> 多行内容',
        '',
        ' ▸ Credits: 0.12 • Time: 9s',
        '',
      ].join('\n');
      const out = f.feed(raw) + f.flush();

      expect(out).toContain('📖 读取 x.md');
      expect(out).toContain('这是 LLM 的回复');
      expect(out).toContain('多行内容');
      expect(out).not.toContain('Successfully read');
      expect(out).not.toContain('Credits:');
      expect(out).not.toContain('Completed in');
      expect(out).not.toContain('>');
    });
  });
});

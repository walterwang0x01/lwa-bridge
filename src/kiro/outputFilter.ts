/**
 * kiro-cli stdout 输出过滤
 *
 * kiro-cli 在 --no-interactive 模式下的输出格式：
 *
 *   Reading file: /path (using tool: read)
 *   ✓ Successfully read N bytes from /path
 *   - Completed in 0.0s
 *
 *   I will run the following command: lark-cli ... (using tool: shell)
 *   Purpose: ...
 *   <命令的 stdout 原样吐出，可能是大段 JSON>
 *   - Completed in 0.6s
 *
 *   > 真正的回复
 *
 *    ▸ Credits: 0.12 • Time: 9s
 *
 * 过滤策略（状态机）：
 *   - normal 状态：识别工具调用起始行，转入 in-tool；其他行原样输出
 *   - in-tool 状态：吃掉所有行（包括命令的裸 stdout），直到遇到 `- Completed in`
 *                   完成时输出一行简短摘要
 *   - reply 状态：遇到 `>` 开头进入；去掉 `>` 前缀；遇到 ▸ Credits 退出
 *
 * 设计原则：
 *   - 用户只看到工具调用的简短摘要（"⚙️ 运行 lark-cli ..."），不看裸输出
 *   - 真正的 LLM 回复完整保留
 *   - 完全静默丢弃统计行（Completed/Credits）
 */

interface FilterOutput {
  feed(chunk: string): string;
  flush(): string;
}

export interface FilterOptions {
  /**
   * 工具调用摘要回调。如果传入，trace 摘要会通过这里上报，
   * 不再混入 feed() 返回的字符串里。
   */
  onTrace?: (summary: string) => void;
}

/**
 * 工具调用起始行的识别 + 摘要生成。
 * 匹配中返回简短的展示文本；不匹配返回 null。
 */
function detectToolStart(line: string): string | null {
  const t = line.trim();

  // "Reading file: /path/to/x.md, all lines (using tool: read)"
  let m = t.match(/^Reading file:\s*([^,(]+)/);
  if (m) return `📖 读取 ${basename(m[1] ?? '')}`;

  // "Writing file: /path/to/x.md (using tool: write)"
  m = t.match(/^Writing file:\s*([^,(]+)/);
  if (m) return `✏️ 写入 ${basename(m[1] ?? '')}`;

  // "I will run the following command: <cmd> (using tool: shell)"
  m = t.match(/^I will run the following command:\s*(.+?)\s*\(using tool:/);
  if (m) return `⚙️ 运行 \`${truncate(m[1] ?? '', 60)}\``;

  // "Running command: ..." / "Running tool: ..."
  m = t.match(/^Running (?:command|tool):\s*(.+)/);
  if (m) return `⚙️ 运行 ${truncate(m[2] ?? m[1] ?? '', 60)}`;

  // "Searching for `xxx` (using tool: grep|glob)"
  m = t.match(/^Searching for\s*[`"']?([^`"'\n]+?)[`"']?\s*\(using tool:\s*(grep|glob)/);
  if (m) return `🔍 搜索 \`${truncate(m[1] ?? '', 40)}\``;

  // 通用兜底："... (using tool: xxx)"
  m = t.match(/\(using tool:\s*([a-z_]+)\)/);
  if (m) return `⚙️ 调用 ${m[1]}`;

  return null;
}

/** 完全静默丢弃的行（统计 / Purpose 注释 / Credits 等） */
function isSilent(line: string): boolean {
  const t = line.trim();
  return (
    /^✓ Successfully /.test(t) ||
    /^- Completed in /.test(t) ||
    /^[▸▶]\s*Credits:/.test(t) ||
    /^Purpose:/.test(t) ||
    /^WARNING:/.test(t) // kiro-cli 偶尔的 stderr 警告（如 trust-tools 提示）
  );
}

function basename(p: string): string {
  return p.trim().split('/').pop() || p;
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}

type State = 'normal' | 'in-tool';

export function createKiroOutputFilter(opts: FilterOptions = {}): FilterOutput {
  let buf = '';
  let state: State = 'normal';

  const processLine = (rawLine: string): string => {
    const line = rawLine;
    const t = line.trim();

    // 任何状态下，"Completed in" 都意味着工具调用结束
    if (/^- Completed in /.test(t)) {
      state = 'normal';
      return ''; // 静默
    }

    // 静默统计行
    if (isSilent(line)) return '';

    if (state === 'in-tool') {
      // 处于工具调用中：吃掉裸输出（包括命令的 stdout、JSON dump 等）
      return '';
    }

    // normal 状态：检测工具调用起始
    const toolStart = detectToolStart(line);
    if (toolStart) {
      state = 'in-tool';
      // 通过回调上报；如果没传回调，回退到混入正文
      if (opts.onTrace) {
        opts.onTrace(toolStart);
        return '';
      }
      return toolStart + '\n';
    }

    // > 真正回复 → 去掉 > 前缀
    if (t.startsWith('> ')) {
      return t.slice(2) + '\n';
    }
    if (t === '>') {
      return '\n';
    }

    // 其他原样保留（包括空行）
    return line + '\n';
  };

  return {
    feed(chunk: string): string {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      let out = '';
      for (const line of lines) {
        out += processLine(line);
      }
      return out;
    },
    flush(): string {
      if (!buf) return '';
      const out = processLine(buf);
      buf = '';
      return out;
    },
  };
}

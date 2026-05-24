/**
 * kiro-cli stdout 流解析器
 *
 * 把 kiro-cli 的 ANSI 文本流增量解析成 RunState 的状态变更。
 *
 * kiro-cli 在 --no-interactive 模式下的输出格式（去 ANSI 后）：
 *
 *   Reading file: /path/x.md, all lines (using tool: read)
 *   ✓ Successfully read N bytes from /path/x.md
 *   - Completed in 0.0s
 *
 *   I will run the following command: lark-cli ... (using tool: shell)
 *   Purpose: ...
 *   <命令的 stdout 原样吐出，可能是大段 JSON>
 *   - Completed in 0.6s
 *
 *   > LLM 真正的回复
 *   > 第二行回复
 *
 *    ▸ Credits: 0.12 • Time: 9s
 *
 * 解析策略：
 *   - 状态机两态：normal | in-tool
 *   - normal 状态：识别工具调用起始行，转入 in-tool；识别 `>` 段加文本块
 *   - in-tool 状态：把命令的裸 stdout 累积到当前 ToolEntry.output
 *   - "Completed in" 把 in-tool 转回 normal，并把工具置为 done
 *   - 静默丢弃统计行（✓ Successfully / Credits / Purpose）
 */
import {
  appendText,
  appendToolOutput,
  finishLastRunningTool,
  pushTool,
  type RunState,
  type ToolEntry,
} from './runState.js';

interface ToolStart {
  name: string;
  input: Record<string, unknown>;
}

/**
 * 识别工具调用起始行。
 * 返回 ToolEntry 的 name+input；不匹配返回 null。
 */
function detectToolStart(line: string): ToolStart | null {
  const t = line.trim();

  // "Reading file: /path/to/x.md, all lines (using tool: read)"
  let m = t.match(/^Reading file:\s*([^,(]+?)\s*(?:,([^()]+))?\s*\(using tool:/);
  if (m) {
    const input: Record<string, unknown> = { file_path: (m[1] ?? '').trim() };
    const range = (m[2] ?? '').trim();
    if (range) input['range'] = range;
    return { name: 'Read', input };
  }

  // "Writing file: /path/to/x.md (using tool: write)"
  m = t.match(/^Writing file:\s*([^,(]+?)\s*\(using tool:/);
  if (m) {
    return { name: 'Write', input: { file_path: (m[1] ?? '').trim() } };
  }

  // "I will run the following command: <cmd> (using tool: shell)"
  m = t.match(/^I will run the following command:\s*(.+?)\s*\(using tool:/);
  if (m) {
    return { name: 'Bash', input: { command: (m[1] ?? '').trim() } };
  }

  // "Searching for `xxx` (using tool: grep)"
  m = t.match(/^Searching for\s*[`"']?([^`"'\n]+?)[`"']?\s*\(using tool:\s*(grep|glob)/);
  if (m) {
    const tool = m[2] === 'glob' ? 'Glob' : 'Grep';
    return { name: tool, input: { pattern: (m[1] ?? '').trim() } };
  }

  // "Fetching <url> (using tool: web_fetch)"
  m = t.match(/^(?:Fetching|Browsing)\s+(.+?)\s*\(using tool:\s*web_fetch/);
  if (m) {
    return { name: 'WebFetch', input: { url: (m[1] ?? '').trim() } };
  }

  // "Searching the web for <query> (using tool: web_search)"
  m = t.match(/^Searching the web for\s+(.+?)\s*\(using tool:\s*web_search/);
  if (m) {
    return { name: 'WebSearch', input: { query: (m[1] ?? '').trim() } };
  }

  // 通用兜底："... (using tool: xxx)"
  m = t.match(/\(using tool:\s*([a-z_]+)\)/);
  if (m) {
    return {
      name: prettifyToolName(m[1] ?? 'tool'),
      input: { raw_line: t },
    };
  }

  return null;
}

function prettifyToolName(name: string): string {
  switch (name) {
    case 'fs_read':
    case 'read':
      return 'Read';
    case 'fs_write':
    case 'write':
      return 'Write';
    case 'execute_bash':
    case 'shell':
      return 'Bash';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'web_search':
      return 'WebSearch';
    case 'web_fetch':
      return 'WebFetch';
    case 'use_aws':
      return 'AWS';
    case 'use_subagent':
      return 'Subagent';
    case 'code':
      return 'Code';
    default:
      // 其他：把 snake_case 转成 PascalCase
      return name
        .split('_')
        .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : ''))
        .join('');
  }
}

/** 完全静默丢弃的行（统计 / Purpose 注释 / Credits 等） */
function isSilent(t: string): boolean {
  return (
    /^✓ Successfully /.test(t) ||
    /^[▸▶]\s*Credits:/.test(t) ||
    /^Purpose:/.test(t) ||
    /^WARNING:/.test(t)
  );
}

type ParserState = 'normal' | 'in-tool';

export interface RunStreamParser {
  /**
   * 喂入一段 stdout chunk（已 stripAnsi）。
   * 返回内部状态变更标志，调用方据此触发 patchCard。
   */
  feed(chunk: string, state: RunState): void;
  /** 流结束时把缓冲里残留的内容刷出来 */
  flush(state: RunState): void;
}

/**
 * 创建一个流解析器。
 * 每次 spawn kiro-cli 一个 parser，状态在调用间累积。
 */
export function createRunStreamParser(): RunStreamParser {
  let buf = '';
  let parserState: ParserState = 'normal';
  let toolIdCounter = 0;

  const newToolId = (): string => `t${Date.now().toString(36)}-${toolIdCounter++}`;

  const processLine = (rawLine: string, state: RunState): void => {
    const line = rawLine;
    const t = line.trim();

    // "Completed in 0.6s" → 工具结束
    if (/^- Completed in /.test(t)) {
      finishLastRunningTool(state, 'done');
      parserState = 'normal';
      return;
    }

    // 静默统计行
    if (isSilent(t)) return;

    if (parserState === 'in-tool') {
      // 工具调用中：把裸输出累积到当前 tool 的 output（保留换行）
      appendToolOutput(state, line + '\n');
      return;
    }

    // normal 状态：检测工具调用起始
    const toolStart = detectToolStart(line);
    if (toolStart) {
      const tool: ToolEntry = {
        id: newToolId(),
        name: toolStart.name,
        input: toolStart.input,
        status: 'running',
        startedAt: Date.now(),
      };
      pushTool(state, tool);
      parserState = 'in-tool';
      return;
    }

    // > 真正回复 → 去掉 > 前缀，加到 text block
    if (t.startsWith('> ')) {
      appendText(state, t.slice(2) + '\n');
      return;
    }
    if (t === '>') {
      appendText(state, '\n');
      return;
    }

    // 其他原样保留为文本（包括空行）
    // 但要小心：如果当前是空行而 blocks 末尾是 text，也加进去保持段落感
    if (line.length > 0 || state.blocks[state.blocks.length - 1]?.kind === 'text') {
      appendText(state, line + '\n');
    }
  };

  return {
    feed(chunk: string, state: RunState): void {
      buf += chunk;
      const lines = buf.split('\n');
      // 最后一段可能不完整，留到下次
      buf = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line, state);
      }
    },
    flush(state: RunState): void {
      if (!buf) return;
      processLine(buf, state);
      buf = '';
    },
  };
}

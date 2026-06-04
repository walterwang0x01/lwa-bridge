/**
 * 工具调用 → 卡片片段渲染
 *
 * 把一个 ToolEntry 渲染成：
 *   - header 文字（图标 + 名字 + 简短摘要）
 *   - body markdown（input + output）
 *
 * 详见下方说明。
 *
 * 大小限制：
 *   - input/output 各自 600/1200 字符截断
 *   - body 总大小 2500 字符
 *   - 防止单个工具 panel 超过飞书 30KB element 限制把整张卡冲掉
 */
import type { ToolEntry } from '../kiro/runState.js';
import { homedir } from 'node:os';

const HEADER_SUMMARY_MAX = 80;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
const BODY_TOTAL_MAX = 2500;

/** 状态图标。优先按工具类别（kind）选更贴切的图标，否则回退到通用状态图标。 */
function statusIcon(tool: ToolEntry): string {
  if (tool.status === 'error') return '❌';
  if (tool.status === 'running') return '⏳';
  // done：按 kind 选更有辨识度的图标
  switch (tool.kind) {
    case 'read':
      return '📖';
    case 'edit':
    case 'write':
      return '✏️';
    case 'execute':
      return '⚙️';
    case 'search':
      return '🔍';
    case 'fetch':
      return '🌐';
    default:
      return '✅';
  }
}

/**
 * 工具调用的 header 文本（折叠面板的标题）。
 * 优先用 Kiro 通过 ACP 提供的 title（更准、对 MCP 工具也通用）；
 * 没有 title 才回退到自己拼的 name + input 摘要。
 * 形如：✅ **Read** — ~/lark-kiro-bridge/SKILL.md   或   📖 Reading sample.txt:1
 */
export function toolHeaderText(tool: ToolEntry): string {
  const icon = statusIcon(tool);
  if (tool.title) {
    return `${icon} ${tool.title}`;
  }
  const summary = summarizeInput(tool.name, tool.input);
  return summary ? `${icon} **${tool.name}** — ${summary}` : `${icon} **${tool.name}**`;
}

/**
 * 工具调用的 body markdown（折叠面板内容）。
 */
export function toolBodyMd(tool: ToolEntry): string {
  const parts: string[] = [];
  // Kiro 给的调用目的，作为副标题让用户知道"为什么"调这个工具
  if (tool.purpose) parts.push(`<font color='grey'>${tool.purpose}</font>`);
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);

  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    if (tool.status === 'error') {
      parts.push(`**Error**\n\`\`\`\n${truncated}\n\`\`\``);
    } else if (tool.name === 'Bash') {
      parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
    }
  } else if (tool.status === 'running') {
    parts.push("<font color='grey'>运行中…</font>");
  }

  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n<font color='grey'>（body 已截断，完整内容查 \`/doctor\` 或日志）</font>`;
}

/** Header 简短摘要：从 input 里挑最重要的字段 */
function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const pick = (key: string, max = HEADER_SUMMARY_MAX): string => {
    const v = rec[key];
    if (typeof v !== 'string') return '';
    const oneLine = v.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  };

  switch (name) {
    case 'Bash':
      return pick('command');
    case 'Read':
    case 'Write':
      return shortenPath(pick('file_path'));
    case 'Grep':
    case 'Glob':
      return pick('pattern');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query', 60);
    default:
      return pick('command') || pick('file_path') || pick('pattern') || pick('query');
  }
}

/** Body 里 input 区域的 markdown */
function renderInput(tool: ToolEntry): string {
  const input = tool.input;
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const str = (k: string): string => (typeof rec[k] === 'string' ? (rec[k] as string) : '');

  switch (tool.name) {
    case 'Bash': {
      const cmd = str('command');
      return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : '';
    }
    case 'Read':
    case 'Write': {
      const fp = str('file_path');
      const range = str('range');
      const lines: string[] = [];
      if (fp) lines.push(`**File** \`${shortenPath(fp)}\``);
      if (range) lines.push(`**Range** ${range}`);
      return lines.join('\n');
    }
    case 'Grep':
    case 'Glob': {
      const lines: string[] = [];
      if (str('pattern')) lines.push(`**Pattern** \`${str('pattern')}\``);
      if (str('path')) lines.push(`**Path** \`${shortenPath(str('path'))}\``);
      return lines.join('\n');
    }
    case 'WebFetch':
      return str('url') ? `**URL** ${str('url')}` : '';
    case 'WebSearch':
      return str('query') ? `**Query** \`${truncate(str('query'), BODY_FIELD_MAX)}\`` : '';
    default:
      return '';
  }
}

/** 缩短家目录路径："/Users/admin/x" → "~/x" */
function shortenPath(p: string): string {
  if (!p) return p;
  const home = homedir();
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

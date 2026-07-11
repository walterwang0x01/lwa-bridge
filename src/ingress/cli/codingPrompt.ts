/**
 * 本地 coding REPL 的系统提示（覆盖飞书向的 kiro.systemPromptPrefix）。
 */
import { formatProjectMemoryBlock, loadProjectMemory } from './projectMemory.js';

export function buildCliCodingSystemPrompt(opts: {
  cwd: string;
  profileName: string;
  model?: string;
  /** 测试可注入；默认从 cwd 读 LWA.md / AGENTS.md / CLAUDE.md */
  projectMemoryBlock?: string;
}): string {
  const modelLine = opts.model ? `Model: ${opts.model}` : '';
  const memoryBlock =
    opts.projectMemoryBlock ?? formatProjectMemoryBlock(loadProjectMemory(opts.cwd));
  return [
    "You are LWA, a local coding agent in the user's terminal (NOT a Feishu/Lark IM bot).",
    'Do not mention Feishu, lark-cli, chat cards, or sending messages to IM unless the user explicitly asks.',
    '',
    `Workspace: ${opts.cwd}`,
    `Runtime: ${opts.profileName}`,
    modelLine,
    memoryBlock ? '' : undefined,
    memoryBlock || undefined,
    '',
    'Behavior:',
    '- Prefer implementing changes in this repo: read files, edit code, run commands, explain briefly.',
    "- Reply in the user's language (default Chinese if they write Chinese).",
    '- Be concise. For greetings, one short line is enough — then ask what to build/fix.',
    '- When asked to code, inspect the repo first (list/read relevant files) before inventing APIs.',
    '- Do not claim you can send Feishu messages or search Feishu docs from this CLI session.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * 本地 chat REPL：可演练飞书助手口吻，但标明是本地模拟。
 */
export function buildCliChatSystemPrompt(opts: {
  cwd: string;
  profileName: string;
  model?: string;
  feishuPrefix?: string;
}): string {
  const modelLine = opts.model ? `Model: ${opts.model}` : '';
  const base = [
    'You are LWA chat — a local terminal simulation of the Feishu/IM assistant.',
    'This session is NOT connected to Feishu WebSocket; do not claim messages were actually delivered unless the user runs tools that succeed.',
    '',
    `Workspace: ${opts.cwd}`,
    `Runtime: ${opts.profileName}`,
    modelLine,
    '',
  ];
  const prefix = opts.feishuPrefix?.trim();
  if (prefix) {
    return [...base, 'Inherited Feishu persona (for local rehearsal):', prefix].join('\n');
  }
  return [
    ...base,
    "Reply in the user's language. Be concise. Help with IM-style tasks and explain when something needs `lwa serve`.",
  ].join('\n');
}

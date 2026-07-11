/**
 * CLI 纯文本呈现：把飞书卡片压成可读文本，并去掉终端无法交互的装饰。
 */
export function cardToPlainText(card: object): string {
  const texts: string[] = [];
  walkCard(card, texts);
  return cleanCliText(texts.join('\n\n').trim() || '[empty]');
}

function walkCard(node: unknown, texts: string[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  const header = obj.header as Record<string, unknown> | undefined;
  const title = extractContent(header?.title);
  if (title) texts.push(title);

  const body = obj.body as { elements?: unknown[] } | undefined;
  if (Array.isArray(body?.elements)) {
    for (const el of body.elements) walkCard(el, texts);
  }

  if (obj.tag === 'markdown' || obj.tag === 'plain_text') {
    const content = extractContent(obj);
    if (content) texts.push(content);
  }

  if (Array.isArray(obj.elements)) {
    for (const el of obj.elements) walkCard(el, texts);
  }
}

function extractContent(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  const content = obj.content;
  if (typeof content !== 'string') return '';
  return content
    .replace(/<font[^>]*>/gi, '')
    .replace(/<\/font>/gi, '')
    .trim();
}

/** 去掉飞书卡片残留：按钮提示、credits、折叠装饰等。 */
export function cleanCliText(text: string): string {
  return text
    .replace(/💰[^\n]*/g, '')
    .replace(/展开其他[^\n]*/g, '')
    .replace(/\[ ⏹[^\]]*\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatCliHelp(mode: 'code' | 'chat' = 'code'): string {
  const title = mode === 'chat' ? 'LWA chat REPL (IM rehearsal)' : 'LWA coding REPL';
  const hint =
    mode === 'chat'
      ? 'Chat: rehearse Feishu-style replies locally (no WebSocket).'
      : 'Chat: describe the change you want in this repo.';
  return [
    title,
    '',
    hint,
    '',
    'Workspace',
    '  /pwd                 show cwd',
    '  /cd <path>           change project directory',
    '  /status              cwd · branch · runtime · ctx%',
    '  /doctor              local checkup (plan/runtime/gateway)',
    '  /doctor <issue>      feed logs to Kiro for diagnosis',
    '  /ws list|save|use    named workspaces',
    '',
    'Agent',
    '  /runtime [name]      list / switch engine (kiro|cursor|openai-*)',
    '  /runtime auto        clear sticky; re-enable smart routing',
    '  /runtime check       diagnose profiles + gateway circuit',
    '  /model [name|auto]   show / set model (kiro)',
    '  /models              list OpenAI gateway models (alias)',
    '  /plan [text]         plan phase (no edits) / run a plan prompt',
    '  /apply               apply phase (implement)',
    '  /review [text]       review phase (read-only) / run a review',
    '  /explore <query>     read-only subagent (kiro)',
    '  /test [hint]         test-runner subagent (kiro)',
    '  /compact [focus]     compress session context (auto at ~80k chars)',
    '  /worktree …          git worktree add|use|rm|list',
    '  /parallel <wt> <msg> background agent in worktree',
    '  /jobs [id]           list / inspect parallel jobs',
    '  /sessions            list CLI sessions',
    '  /resume [id]         switch CLI session',
    '  /rename <title>      name current session',
    '  /new                 new session id',
    '  /clear               clear summary (keep session id)',
    '  /stop                abort running task',
    '',
    'Optional: BrowserSkill (`bsk`) for logged-in browser — install separately, not bundled.',
    '',
    'Meta: /help  .exit',
    '',
    'Modes: lwa code [--continue|--resume <id>] | lwa chat | lwa serve',
  ].join('\n');
}

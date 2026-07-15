/**
 * CLI 纯文本呈现：把飞书卡片压成可读文本（含 column_set / button），
 * 并去掉终端无法交互的装饰。
 */
export function cardToPlainText(card: object): string {
  const texts: string[] = [];
  walkCard(card, texts, new Set());
  let out = cleanCliText(texts.join('\n').trim() || '[empty]');
  if (/\[[^\]]+\]/.test(out) && !out.includes('CLI tip:')) {
    out = `${out}\n\n(CLI tip: buttons don't work here — use slash text, e.g. /ws use <name>, /exit <id>)`;
  }
  return out;
}

function walkCard(node: unknown, texts: string[], seen: Set<unknown>): void {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  const obj = node as Record<string, unknown>;

  const header = obj.header as Record<string, unknown> | undefined;
  const title = extractContent(header?.title);
  if (title) texts.push(title);

  const body = obj.body as { elements?: unknown[] } | undefined;
  if (Array.isArray(body?.elements)) {
    for (const el of body.elements) walkCard(el, texts, seen);
  }

  const tag = typeof obj.tag === 'string' ? obj.tag : '';

  if (tag === 'markdown' || tag === 'plain_text' || tag === 'lark_md') {
    const content = extractContent(obj);
    if (content) texts.push(content);
  } else if (tag === 'div') {
    const text = extractContent(obj.text) || extractContent(obj);
    if (text) texts.push(text);
  } else if (tag === 'button') {
    const label =
      extractContent(obj.text) ||
      extractContent(obj.name) ||
      (typeof obj.content === 'string' ? obj.content : '');
    if (label) texts.push(`[${label.trim()}]`);
  } else if (tag === 'input' || tag === 'textarea') {
    const placeholder = extractContent(obj.placeholder) || extractContent(obj.label);
    const def =
      typeof obj.default_value === 'string'
        ? obj.default_value
        : typeof obj.value === 'string'
          ? obj.value
          : '';
    if (placeholder || def) {
      texts.push(def ? `${placeholder || 'input'}: ${def}` : `${placeholder || 'input'}: (empty)`);
    }
  } else if (tag === 'column_set') {
    if (Array.isArray(obj.columns)) {
      for (const col of obj.columns) walkCard(col, texts, seen);
    }
  } else if (tag === 'column') {
    if (Array.isArray(obj.elements)) {
      for (const el of obj.elements) walkCard(el, texts, seen);
    }
  } else {
    if (Array.isArray(obj.elements)) {
      for (const el of obj.elements) walkCard(el, texts, seen);
    }
    if (Array.isArray(obj.columns)) {
      for (const col of obj.columns) walkCard(col, texts, seen);
    }
    if (Array.isArray(obj.actions)) {
      for (const a of obj.actions) walkCard(a, texts, seen);
    }
  }
}

function extractContent(node: unknown): string {
  if (typeof node === 'string') return node.trim();
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  const content = obj.content;
  if (typeof content === 'string') {
    return content
      .replace(/<font[^>]*>/gi, '')
      .replace(/<\/font>/gi, '')
      .trim();
  }
  if (obj.text && typeof obj.text === 'object') return extractContent(obj.text);
  return '';
}

/** 去掉飞书卡片残留：credits、折叠装饰等。 */
export function cleanCliText(text: string): string {
  return text
    .replace(/💰[^\n]*/g, '')
    .replace(/展开其他[^\n]*/g, '')
    .replace(/\[ ⏹[^\]]*\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatCliHelp(mode: 'code' | 'chat' = 'code'): string {
  const title = mode === 'chat' ? 'LWA chat REPL (IM rehearsal)' : 'LWA Code Shell (Auto routing)';
  const hint =
    mode === 'chat'
      ? 'Chat: rehearse Feishu-style replies locally (no WebSocket).'
      : 'Default `lwa code` uses LWA Shell with Auto routing (kiro / cursor / gateway).';
  return [
    title,
    '',
    hint,
    '',
    'Type / for live menu (↑↓ · Enter). Full list:',
    '',
    'Workspace',
    '  /pwd  /cd <path>  /ws list|save|use|remove',
    '  /status  /doctor [issue]  /timeout [N|off|default]',
    '',
    'Agent / routing',
    '  /runtime [name|auto|check]   /yolo [on|off]',
    '  /model [name|auto]           /models (= /model)',
    '  /plan|/apply|/review [text]  /explore <q>  /test [hint]',
    '  /compact [focus]  /agent …  /skill …',
    '',
    'Sessions / jobs',
    '  /sessions  /resume [id]  /rename <title>  /new  /clear  /stop',
    '  /worktree list|add|use|rm  /parallel <wt> <msg>  /jobs [id]',
    '  /conduit status|plan|run   (merge confirm: Feishu-only)',
    '',
    'Ops (CLI text; Feishu form buttons N/A)',
    '  /config  /ps  /exit <id>  /memory|/steering …  /cron …',
    '  /selftest  /reconnect (gateway only)',
    '',
    'Meta: /help  .exit',
    'Unknown /xxx is forwarded to the agent.',
    '',
    'Modes: lwa code | lwa code --native | lwa chat | lwa serve',
  ].join('\n');
}

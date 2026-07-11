import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { DATA_DIR, ensureDataDirs } from '../lib/paths.js';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeProfile,
  UnifiedSessionEvent,
} from './types.js';

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

interface SessionRecord {
  cwd: string;
  messages: OpenAIMessage[];
  updatedAt: number;
}

interface SessionsFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

const OPENAI_SESSIONS_FILE = join(DATA_DIR, 'openai-sessions.json');

const CAPABILITIES: RuntimeCapabilities = {
  acp: false,
  streaming: false,
  toolEvents: false,
  sessionResume: true,
  parallelWorkers: true,
  skills: false,
  poolable: false,
};

function readSessionsFile(): SessionsFile {
  if (!existsSync(OPENAI_SESSIONS_FILE)) {
    return { version: 1, sessions: {} };
  }
  try {
    const raw = readFileSync(OPENAI_SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as SessionsFile;
    if (parsed && parsed.version === 1 && parsed.sessions) return parsed;
  } catch {
    // ignore broken file and reset
  }
  return { version: 1, sessions: {} };
}

function writeSessionsFile(data: SessionsFile): void {
  ensureDataDirs();
  writeFileSync(OPENAI_SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function withSessionsLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(OPENAI_SESSIONS_FILE)) {
    writeFileSync(OPENAI_SESSIONS_FILE, '{\n  "version": 1,\n  "sessions": {}\n}\n', {
      mode: 0o600,
    });
  }
  const release = await lockfile.lock(OPENAI_SESSIONS_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

async function ensureSession(sessionId: string, cwd: string): Promise<SessionRecord> {
  return withSessionsLock(() => {
    const data = readSessionsFile();
    const existing = data.sessions[sessionId];
    if (existing) return existing;
    const created: SessionRecord = { cwd, messages: [], updatedAt: Date.now() };
    data.sessions[sessionId] = created;
    writeSessionsFile(data);
    return created;
  });
}

async function createSession(cwd: string): Promise<string> {
  const id = randomUUID();
  await ensureSession(id, cwd);
  return id;
}

async function updateSession(
  sessionId: string,
  updater: (record: SessionRecord) => SessionRecord,
): Promise<void> {
  await withSessionsLock(() => {
    const data = readSessionsFile();
    let current = data.sessions[sessionId];
    if (!current) {
      current = { cwd: '', messages: [], updatedAt: Date.now() };
    }
    data.sessions[sessionId] = updater(current);
    writeSessionsFile(data);
  });
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const obj = part as Record<string, unknown>;
      if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
      return '';
    })
    .join('')
    .trim();
}

function chatCompletionsUrl(apiBase: string): string {
  const normalized = apiBase.endsWith('/') ? apiBase : `${apiBase}/`;
  return new URL('chat/completions', normalized).toString();
}

export class OpenAICompatibleRuntime implements AgentRuntime {
  readonly kind = 'openai-compatible' as const;
  readonly capabilities = CAPABILITIES;

  private readonly profile: RuntimeProfile;
  private readonly cwd: string;
  private readonly extraEnv?: Record<string, string>;
  private abortController: AbortController | null = null;
  private sessionId = '';

  constructor(profile: RuntimeProfile, opts: { cwd: string; extraEnv?: Record<string, string> }) {
    this.profile = profile;
    this.cwd = opts.cwd;
    if (opts.extraEnv) this.extraEnv = opts.extraEnv;
  }

  async initialize(): Promise<void> {}

  async newSession(cwd: string): Promise<string> {
    this.sessionId = await createSession(cwd);
    return this.sessionId;
  }

  async loadSession(id: string, cwd: string): Promise<void> {
    await ensureSession(id, cwd);
    this.sessionId = id;
  }

  async *prompt(sessionId: string, text: string): AsyncIterable<UnifiedSessionEvent> {
    const sid = sessionId || this.sessionId || (await this.newSession(this.cwd));
    const record = await ensureSession(sid, this.cwd);
    this.sessionId = sid;

    const apiKey =
      this.profile.apiKey ?? this.extraEnv?.['OPENAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
    const apiBase =
      this.profile.apiBase ?? this.extraEnv?.['OPENAI_API_BASE'] ?? process.env['OPENAI_API_BASE'];
    const model =
      this.profile.model ?? this.extraEnv?.['OPENAI_MODEL'] ?? process.env['OPENAI_MODEL'];

    if (!apiKey) throw new Error('openai-compatible runtime missing API key');
    if (!apiBase) throw new Error('openai-compatible runtime missing API base');
    if (!model) throw new Error('openai-compatible runtime missing model');

    const messages: OpenAIMessage[] = [];
    const systemPrompt = this.profile.systemPromptPrefix?.trim();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push(...record.messages, { role: 'user', content: text });

    this.abortController = new AbortController();
    const res = await fetch(chatCompletionsUrl(apiBase), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal: this.abortController.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`openai-compatible request failed: ${res.status} ${body}`.trim());
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { total_tokens?: number };
    };
    const answer = textOfContent(json.choices?.[0]?.message?.content);

    await updateSession(sid, (current) => ({
      ...current,
      updatedAt: Date.now(),
      messages: [
        ...current.messages,
        { role: 'user', content: text },
        { role: 'assistant', content: answer },
      ],
    }));

    if (answer) {
      yield { kind: 'message', sessionId: sid, text: answer };
    }
    if (typeof json.usage?.total_tokens === 'number') {
      yield { kind: 'metadata', sessionId: sid, credits: json.usage.total_tokens };
    }
    yield { kind: 'turn_end', sessionId: sid, stopReason: 'end_turn' };
  }

  async cancel(_sessionId: string): Promise<void> {
    this.abortController?.abort();
  }

  async close(): Promise<void> {
    this.abortController = null;
  }

  get availableSkills(): Array<{ name: string; description: string }> {
    return [];
  }
}

/** 读取 openai 会话消息（供 /compact）。 */
export async function readOpenAISessionMessages(
  sessionId: string,
): Promise<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>> {
  if (!sessionId) return [];
  return withSessionsLock(() => {
    const data = readSessionsFile();
    const rec = data.sessions[sessionId];
    return rec?.messages ?? [];
  });
}

/** 用摘要替换 openai 会话历史（保留一条 user 摘要）。 */
export async function replaceOpenAISessionWithSummary(
  sessionId: string,
  cwd: string,
  summary: string,
): Promise<void> {
  await updateSession(sessionId, (current) => ({
    ...current,
    cwd: current.cwd || cwd,
    updatedAt: Date.now(),
    messages: [{ role: 'user', content: summary }],
  }));
}

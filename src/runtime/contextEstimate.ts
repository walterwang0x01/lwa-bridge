/**
 * 估算当前会话上下文占用（供 /status 与 auto-compact 共用）。
 */
import type { Config } from '../lib/config.js';
import type { SessionStore } from '../store/sessions.js';
import type { RuntimeProfile } from './types.js';
import { decodeSessionId } from './sessionId.js';
import { estimateContextChars } from './autoCompact.js';
import { readOpenAISessionMessages } from './openaiCompatibleRuntime.js';

export async function estimateSessionContext(opts: {
  config: Config;
  sessions: SessionStore;
  conversationId: string;
  cwd: string;
  profile: RuntimeProfile;
  extra?: string[];
}): Promise<{
  chars: number;
  thresholdChars: number;
  pct: number;
  messageCount: number;
  hasSummary: boolean;
}> {
  const thresholdChars = opts.config.runtime?.compact?.thresholdChars ?? 80_000;
  const session = await opts.sessions.getConversation(
    opts.conversationId,
    opts.config.workspace.defaultCwd,
  );
  const summary = session.compactionSummary ?? '';
  let messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  const agentSid = await opts.sessions.getConversationAgentSession(opts.conversationId, opts.cwd);
  if (opts.profile.kind === 'openai-compatible' && agentSid) {
    const nativeId = decodeSessionId(agentSid, opts.profile.kind);
    if (nativeId) messages = await readOpenAISessionMessages(nativeId);
  }
  if (messages.length === 0 && summary) {
    messages = [{ role: 'user', content: summary }];
  }
  const chars = estimateContextChars(messages, [summary, ...(opts.extra ?? [])]);
  const pct = Math.min(999, Math.round((chars / thresholdChars) * 100));
  return {
    chars,
    thresholdChars,
    pct,
    messageCount: messages.length,
    hasSummary: Boolean(summary),
  };
}

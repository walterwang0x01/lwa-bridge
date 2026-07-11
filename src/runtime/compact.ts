/**
 * LWA 层会话压缩：把长 transcript 收成可读摘要（优先用 openai-fast，失败则截断启发式）。
 */
import type { Config } from '../lib/config.js';
import { resolveRuntimeProfile } from '../runtime/config.js';
import { listRuntimeProfileNames } from '../runtime/config.js';

export type CompactMessage = { role: 'user' | 'assistant' | 'system'; content: string };

function heuristicSummary(messages: CompactMessage[], focus?: string): string {
  const recent = messages.filter((m) => m.role !== 'system').slice(-12);
  const lines = recent.map((m) => `- [${m.role}] ${m.content.slice(0, 240).replace(/\s+/g, ' ')}`);
  const focusLine = focus ? `Focus: ${focus}\n` : '';
  return [
    '[LWA compacted session]',
    focusLine.trimEnd(),
    `Kept ${recent.length} recent turns (heuristic; gateway unavailable).`,
    ...lines,
  ]
    .filter(Boolean)
    .join('\n');
}

async function llmSummarize(
  cfg: Config,
  messages: CompactMessage[],
  focus?: string,
): Promise<string | undefined> {
  const names = listRuntimeProfileNames(cfg);
  const candidate =
    names.find((n) => n === 'openai-fast') ??
    names.find((n) => {
      try {
        return resolveRuntimeProfile(cfg, n).kind === 'openai-compatible';
      } catch {
        return false;
      }
    });
  if (!candidate) return undefined;
  let profile: ReturnType<typeof resolveRuntimeProfile>;
  try {
    profile = resolveRuntimeProfile(cfg, candidate);
  } catch {
    return undefined;
  }
  const apiKey = profile.apiKey ?? process.env['OPENAI_API_KEY'];
  const apiBase = profile.apiBase ?? process.env['OPENAI_API_BASE'];
  const model = profile.model ?? process.env['OPENAI_MODEL'];
  if (!apiKey || !apiBase || !model) return undefined;

  const transcript = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 2000)}`)
    .join('\n\n')
    .slice(0, 24_000);

  const url = new URL('chat/completions', apiBase.endsWith('/') ? apiBase : `${apiBase}/`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Summarize this coding-agent conversation for continuity after context compaction. Keep: goals, decisions, files touched, remaining todos, constraints. Drop chatter. Max 40 lines.',
          },
          {
            role: 'user',
            content: `${focus ? `Focus instructions: ${focus}\n\n` : ''}Transcript:\n${transcript}`,
          },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return undefined;
    return `[LWA compacted session]\n${text}`;
  } catch {
    return undefined;
  }
}

/** 压缩消息列表为摘要字符串。 */
export async function compactMessages(
  cfg: Config,
  messages: CompactMessage[],
  focus?: string,
): Promise<{ summary: string; via: 'llm' | 'heuristic' }> {
  if (messages.length === 0) {
    return { summary: '[LWA compacted session]\n(empty)', via: 'heuristic' };
  }
  const llm = await llmSummarize(cfg, messages, focus);
  if (llm) return { summary: llm, via: 'llm' };
  return { summary: heuristicSummary(messages, focus), via: 'heuristic' };
}

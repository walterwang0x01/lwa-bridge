/**
 * OpenAI 兼容网关模型发现与档位启发式分类。
 *
 * 标准探测：GET {apiBase}/models（与 OpenAI API 一致）。
 * fast/strong 不是网关返回的字段，而是 bridge 根据模型 id 做的启发式分层，
 * 用于路由建议；最终以 config 里 profile.model 为准。
 */
import type { RuntimeProfile } from './types.js';

export type ModelTier = 'fast' | 'balanced' | 'strong' | 'unknown';

export interface OpenAIModelListResult {
  models: string[];
  defaultModel?: string;
  error?: string;
}

function modelsUrl(apiBase: string): string {
  const normalized = apiBase.endsWith('/') ? apiBase : `${apiBase}/`;
  return new URL('models', normalized).toString();
}

/** 从 OpenAI 兼容 GET /models 拉取模型 id 列表。 */
export async function listOpenAIModels(profile: RuntimeProfile): Promise<OpenAIModelListResult> {
  const apiKey = profile.apiKey ?? process.env['OPENAI_API_KEY'];
  const apiBase = profile.apiBase ?? process.env['OPENAI_API_BASE'];
  if (!apiKey || !apiBase) {
    return { models: [], error: 'missing apiKey or apiBase' };
  }
  try {
    const res = await fetch(modelsUrl(apiBase), {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { models: [], error: `GET /models ${res.status} ${body}`.trim() };
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort();
    return {
      models,
      defaultModel: profile.model,
    };
  } catch (e) {
    return { models: [], error: (e as Error).message };
  }
}

/** 根据模型 id 猜测档位（启发式，非网关官方字段）。 */
export function classifyModelTier(modelId: string): ModelTier {
  const id = modelId.toLowerCase();
  if (
    /haiku|mini|flash|fast|small|lite|nano|turbo-3\.5|gpt-3\.5|deepseek.*chat|qwen.*turbo/.test(id)
  ) {
    return 'fast';
  }
  if (
    /opus|sonnet|gpt-4|gpt-5|pro|max|ultra|thinking|o1|o3|claude-3\.5|claude-4|claude-sonnet/.test(
      id,
    )
  ) {
    return 'strong';
  }
  if (id.length > 0) return 'balanced';
  return 'unknown';
}

export function suggestFastStrongModels(models: string[]): {
  fast?: string;
  strong?: string;
  tiers: Record<string, ModelTier>;
} {
  const tiers: Record<string, ModelTier> = {};
  const fastCandidates: string[] = [];
  const strongCandidates: string[] = [];
  for (const m of models) {
    const tier = classifyModelTier(m);
    tiers[m] = tier;
    if (tier === 'fast') fastCandidates.push(m);
    if (tier === 'strong') strongCandidates.push(m);
  }
  return {
    fast: fastCandidates[0],
    strong: strongCandidates[0],
    tiers,
  };
}

export function formatModelTierSummary(models: string[], max = 12): string {
  if (models.length === 0) return '（未拉取到模型列表）';
  const { tiers } = suggestFastStrongModels(models);
  const lines = models.slice(0, max).map((m) => `${m} [${tiers[m] ?? 'unknown'}]`);
  const more = models.length > max ? `\n… 另有 ${models.length - max} 个` : '';
  return lines.join('\n') + more;
}

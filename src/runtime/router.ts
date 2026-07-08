/**
 * 智能 runtime 路由：简单任务优先 cursor，复杂任务优先 kiro。
 */
import { spawnSync } from 'node:child_process';
import type { Config } from '../lib/config.js';
import { listModels } from '../kiro/models.js';
import { defaultRuntimeProfiles, resolveRuntimeProfile } from './config.js';
import type { ModelRouteDecision, RuntimeProfile } from './types.js';

export interface RuntimeRouteContext {
  prompt: string;
  mediaCount?: number;
  commandName?: string;
}

export interface RuntimeDecision {
  profileName: string;
  profile: RuntimeProfile;
  reason: string;
  complexityScore?: number;
}

function isBinAvailable(bin: string): boolean {
  const res = spawnSync('which', [bin], { stdio: 'ignore' });
  return res.status === 0;
}

function availableProfiles(cfg: Config): Array<{ name: string; profile: RuntimeProfile }> {
  const names = Object.keys({ ...defaultRuntimeProfiles(cfg), ...(cfg.runtime?.profiles ?? {}) });
  return names
    .map((name) => ({ name, profile: resolveRuntimeProfile(cfg, name) }))
    .filter(({ profile }) => isBinAvailable(profile.bin));
}

export function complexityScore(cfg: Config, ctx: RuntimeRouteContext): number {
  const prompt = ctx.prompt.trim();
  const lower = prompt.toLowerCase();
  const rules = cfg.runtime?.router?.rules;
  let score = 0;

  if ((ctx.mediaCount ?? 0) > 0) score += 3;
  if (prompt.length > (rules?.maxPromptCharsForCursor ?? 800)) score += 2;
  if ((prompt.match(/\n/g) ?? []).length >= 6) score += 1;
  if (/(先|然后|最后|1\.|2\.|3\.|step|steps)/i.test(prompt)) score += 2;
  if (/```|monorepo|全库|跨仓库|重构|架构|review|多文件|并发|dag|workflow/i.test(prompt))
    score += 3;
  for (const kw of rules?.complexKeywords ?? []) {
    if (lower.includes(kw.toLowerCase())) score += 2;
  }
  if (ctx.commandName === 'doctor' || ctx.commandName === 'conduit') score += 5;
  return score;
}

export function chooseRuntimeProfile(
  cfg: Config,
  ctx: RuntimeRouteContext,
  explicitProfileName?: string,
): RuntimeDecision {
  if (explicitProfileName) {
    return {
      profileName: explicitProfileName,
      profile: resolveRuntimeProfile(cfg, explicitProfileName),
      reason: 'explicit-profile',
      complexityScore: complexityScore(cfg, ctx),
    };
  }

  const mode = cfg.runtime?.router?.mode ?? 'manual';
  const available = availableProfiles(cfg);
  if (available.length === 1) {
    const only = available[0]!;
    return {
      profileName: only.name,
      profile: only.profile,
      reason: 'single-available-runtime',
      complexityScore: complexityScore(cfg, ctx),
    };
  }

  const defaultName = cfg.runtime?.default ?? 'kiro';
  if (mode !== 'smart' || defaultName !== 'auto') {
    const score = complexityScore(cfg, ctx);
    return {
      profileName: defaultName === 'auto' ? 'kiro' : defaultName,
      profile: resolveRuntimeProfile(cfg, defaultName === 'auto' ? 'kiro' : defaultName),
      reason: mode === 'smart' ? 'auto-fallback-default' : 'manual-default',
      complexityScore: score,
    };
  }

  const lark = cfg.runtime?.router?.lark;
  const simpleName = lark?.simpleProfile ?? 'cursor';
  const complexName = lark?.complexProfile ?? 'kiro';
  const score = complexityScore(cfg, ctx);
  const threshold = cfg.runtime?.router?.rules?.complexityThreshold ?? 4;
  const preferredName = score >= threshold ? complexName : simpleName;
  const fallbackName = preferredName === simpleName ? complexName : simpleName;

  for (const candidate of [
    preferredName,
    fallbackName,
    ...(cfg.runtime?.router?.fallbackProfiles ?? []),
  ]) {
    const hit = available.find((p) => p.name === candidate);
    if (hit) {
      return {
        profileName: hit.name,
        profile: hit.profile,
        reason:
          score >= threshold ? `smart-complex(score=${score})` : `smart-simple(score=${score})`,
        complexityScore: score,
      };
    }
  }

  return {
    profileName: 'kiro',
    profile: resolveRuntimeProfile(cfg, 'kiro'),
    reason: 'smart-hard-fallback',
    complexityScore: score,
  };
}

function pickFirst(models: string[], candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (models.includes(candidate)) return candidate;
  }
  return undefined;
}

export async function chooseModelForProfile(
  cfg: Config,
  profile: RuntimeProfile,
  ctx: RuntimeRouteContext,
): Promise<ModelRouteDecision> {
  if (profile.kind === 'cursor-agent-cli') {
    return {
      mode: 'fixed',
      selectedModel: cfg.modelRouting.cursor.model ?? profile.model ?? 'Auto',
      reason: 'cursor-fixed-auto',
      complexityScore: complexityScore(cfg, ctx),
      availableModelCount: 1,
    };
  }

  const score = complexityScore(cfg, ctx);
  if (cfg.modelRouting.kiro.mode === 'fixed') {
    return {
      mode: 'fixed',
      selectedModel: profile.model,
      reason: profile.model ? 'kiro-fixed-profile' : 'kiro-fixed-default',
      complexityScore: score,
    };
  }

  const list = await listModels(profile.bin);
  if (!list || list.models.length === 0) {
    return {
      mode: 'smart',
      selectedModel: profile.model,
      reason: `kiro-smart-no-list(score=${score})`,
      complexityScore: score,
    };
  }

  const names = list.models.map((m) => m.name);
  const mediumThreshold = cfg.modelRouting.kiro.mediumThreshold;
  const hardThreshold = cfg.modelRouting.kiro.hardThreshold;

  let tier: 'simple' | 'medium' | 'hard' = 'simple';
  if (score >= hardThreshold) tier = 'hard';
  else if (score >= mediumThreshold) tier = 'medium';

  let selected: string | undefined;
  if (tier === 'hard') {
    selected =
      pickFirst(names, ['claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6']) ??
      pickFirst(names, ['claude-sonnet-5', 'claude-sonnet-4.6']) ??
      list.defaultModel;
  } else if (tier === 'medium') {
    selected =
      pickFirst(names, ['claude-sonnet-5', 'claude-sonnet-4.6', 'claude-sonnet-4.5']) ??
      pickFirst(names, ['claude-opus-4.8', 'claude-opus-4.7']) ??
      list.defaultModel;
  } else {
    selected =
      pickFirst(names, [
        'claude-sonnet-4.6',
        'claude-sonnet-4.5',
        'claude-sonnet-4',
        'claude-haiku-4.5',
      ]) ??
      pickFirst(names, ['claude-sonnet-5', 'minimax-m2.5', 'deepseek-3.2']) ??
      list.defaultModel;
  }

  return {
    mode: 'smart',
    selectedModel: selected,
    reason: `kiro-smart-${tier}(score=${score})`,
    complexityScore: score,
    tier,
    availableModelCount: names.length,
  };
}

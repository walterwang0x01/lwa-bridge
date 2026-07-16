/**
 * 智能 runtime 路由：按 harness 模式（code/chat/lark）+ 套餐 plan 选引擎。
 * OpenAPI 网关可选：熔断打开时从候选剔除。
 */
import type { Config } from '../lib/config.js';
import { resolveRuntimeProfile } from './config.js';
import { discoverRuntimeRegistry } from './registry.js';
import { fallbackProfilesForBucket, pickFirstQuotaOkProfile, uniqueProfileOrder } from './quota.js';
import type { RuntimeKind, ModelRouteDecision, RuntimeProfile } from './types.js';
import { resolveModeRouteTable, type HarnessMode } from './planProfiles.js';
import { sharedGatewayHealth, type GatewayHealth } from './gatewayHealth.js';

export type TaskBucket = 'chat' | 'review' | 'plan' | 'edit' | 'conduit';

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

export function classifyTaskBucket(ctx: RuntimeRouteContext): TaskBucket {
  if (ctx.commandName === 'conduit') return 'conduit';
  if (ctx.commandName === 'doctor') return 'review';
  const prompt = ctx.prompt.toLowerCase();
  if (/plan|规划|拆分|dag|workflow/.test(prompt)) return 'plan';
  if (/review|审查|检查|代码评审/.test(prompt)) return 'review';
  if (/修改|重构|编辑|multi-file|多文件|patch/.test(prompt)) return 'edit';
  return 'chat';
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

async function filterByGatewayHealth(
  available: Array<{ name: string; profile: RuntimeProfile }>,
  gatewayOptional: boolean,
  health: GatewayHealth,
): Promise<{
  available: Array<{ name: string; profile: RuntimeProfile }>;
  skipped: string[];
}> {
  if (!gatewayOptional) return { available, skipped: [] };
  const kept: Array<{ name: string; profile: RuntimeProfile }> = [];
  const skipped: string[] = [];
  for (const entry of available) {
    if (entry.profile.kind !== 'openai-compatible') {
      kept.push(entry);
      continue;
    }
    if (!health.allows(entry.profile, entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    const state = health.getState(entry.profile, entry.name);
    if (state === 'half-open') {
      const probe = await health.probe(entry.profile, entry.name);
      if (!probe.ok) {
        skipped.push(entry.name);
        continue;
      }
    }
    kept.push(entry);
  }
  return { available: kept, skipped };
}

export async function chooseRuntimeProfile(
  cfg: Config,
  ctx: RuntimeRouteContext,
  explicitProfileName?: string,
  options?: {
    taskBucket?: TaskBucket;
    monthUsageByKind?: Partial<Record<RuntimeKind, number>>;
    /** harness 模式：决定用哪张路由表（默认 lark，兼容旧行为） */
    harnessMode?: HarnessMode;
    health?: GatewayHealth;
  },
): Promise<RuntimeDecision> {
  const taskBucket = options?.taskBucket ?? classifyTaskBucket(ctx);
  const monthUsageByKind = options?.monthUsageByKind;
  const harnessMode = options?.harnessMode ?? 'lark';
  const health = options?.health ?? sharedGatewayHealth;
  const modeTable = resolveModeRouteTable(cfg, harnessMode);

  if (explicitProfileName) {
    const profile = resolveRuntimeProfile(cfg, explicitProfileName);
    if (
      profile.kind === 'openai-compatible' &&
      modeTable.gatewayOptional &&
      !health.allows(profile, explicitProfileName)
    ) {
      return {
        profileName: explicitProfileName,
        profile,
        reason: 'explicit-profile;gateway-circuit-open',
        complexityScore: complexityScore(cfg, ctx),
      };
    }
    const available = [{ name: explicitProfileName, profile }];
    const quotaPick = await pickFirstQuotaOkProfile(
      [explicitProfileName],
      available,
      cfg,
      monthUsageByKind,
    );
    if (!quotaPick) {
      return {
        profileName: explicitProfileName,
        profile,
        reason: 'explicit-profile-quota-depleted',
        complexityScore: complexityScore(cfg, ctx),
      };
    }
    const reason =
      quotaPick.quota.state === 'unknown'
        ? 'explicit-profile'
        : `explicit-profile;quota=${quotaPick.quota.state}`;
    return {
      profileName: explicitProfileName,
      profile,
      reason,
      complexityScore: complexityScore(cfg, ctx),
    };
  }

  const mode = cfg.runtime?.router?.mode ?? 'manual';
  let available = (await discoverRuntimeRegistry(cfg))
    .filter((entry) => entry.available)
    .map((entry) => ({ name: entry.profileName, profile: entry.profile }));

  const filtered = await filterByGatewayHealth(available, modeTable.gatewayOptional, health);
  available = filtered.available;
  const gatewaySkipNote =
    filtered.skipped.length > 0 ? `;gateway_skip(${filtered.skipped.join(',')})` : '';

  if (available.length === 1) {
    const only = available[0]!;
    return {
      profileName: only.name,
      profile: only.profile,
      reason: `single-available-runtime${gatewaySkipNote}`,
      complexityScore: complexityScore(cfg, ctx),
    };
  }

  const defaultName = cfg.runtime?.default ?? 'kiro';
  // code/chat：即使 default≠auto，smart 模式也走 mode 路由表（避免飞书 openai 路由污染 coding）
  const useSmartModeTable =
    mode === 'smart' &&
    (defaultName === 'auto' || harnessMode === 'code' || harnessMode === 'chat');

  if (!useSmartModeTable) {
    const score = complexityScore(cfg, ctx);
    const name = defaultName === 'auto' ? modeTable.complexProfile : defaultName;
    const hit = available.find((a) => a.name === name);
    if (hit) {
      return {
        profileName: hit.name,
        profile: hit.profile,
        reason: `${mode === 'smart' ? 'auto-fallback-default' : 'manual-default'};mode=${harnessMode}${gatewaySkipNote}`,
        complexityScore: score,
      };
    }
    const fb = available[0];
    if (fb) {
      return {
        profileName: fb.name,
        profile: fb.profile,
        reason: `manual-default-fallback;mode=${harnessMode}${gatewaySkipNote}`,
        complexityScore: score,
      };
    }
    return {
      profileName: 'kiro',
      profile: resolveRuntimeProfile(cfg, 'kiro'),
      reason: `smart-hard-fallback;mode=${harnessMode}${gatewaySkipNote}`,
      complexityScore: score,
    };
  }

  const simpleName = modeTable.simpleProfile;
  const complexName =
    taskBucket === 'conduit' ? modeTable.conduitProfile : modeTable.complexProfile;
  const score = complexityScore(cfg, ctx);
  const threshold = cfg.runtime?.router?.rules?.complexityThreshold ?? 4;
  const preferredName = score >= threshold ? complexName : simpleName;
  const fallbackName = preferredName === simpleName ? complexName : simpleName;

  const bucketFb =
    modeTable.fallbackByBucket?.[taskBucket] ?? fallbackProfilesForBucket(taskBucket, cfg);

  const profileOrder = uniqueProfileOrder(
    [preferredName, fallbackName],
    bucketFb,
    modeTable.fallbackProfiles,
    cfg.runtime?.router?.fallbackProfiles ?? [],
    ['kiro', 'cursor', 'gemini', 'openai-fast', 'openai-strong'],
  );

  const quotaPick = await pickFirstQuotaOkProfile(profileOrder, available, cfg, monthUsageByKind);
  if (quotaPick) {
    const baseReason =
      score >= threshold
        ? `smart-complex(score=${score});mode=${harnessMode}`
        : `smart-simple(score=${score});mode=${harnessMode}`;
    const quotaNote =
      quotaPick.name !== preferredName
        ? `;quota_fallback(${preferredName}->${quotaPick.name})`
        : quotaPick.quota.state !== 'unknown'
          ? `;quota=${quotaPick.quota.state}`
          : '';
    return {
      profileName: quotaPick.name,
      profile: quotaPick.profile,
      reason: `${baseReason}${quotaNote}${gatewaySkipNote}`,
      complexityScore: score,
    };
  }

  return {
    profileName: 'kiro',
    profile: resolveRuntimeProfile(cfg, 'kiro'),
    reason:
      available.length > 0
        ? `quota-all-depleted;mode=${harnessMode}${gatewaySkipNote}`
        : `smart-hard-fallback;mode=${harnessMode}${gatewaySkipNote}`,
    complexityScore: score,
  };
}

function pickFirst(models: string[], candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (models.includes(candidate)) return candidate;
  }
  return undefined;
}

function candidatesForTier(tierProfile: string, fallback: string[]): string[] {
  switch (tierProfile) {
    case 'max':
      return ['claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', ...fallback];
    case 'strong':
      return ['claude-sonnet-5', 'claude-sonnet-4.6', 'claude-sonnet-4.5', ...fallback];
    case 'fast':
      return ['claude-haiku-4.5', 'deepseek-3.2', 'minimax-m2.5', ...fallback];
    default:
      return ['claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-sonnet-4', ...fallback];
  }
}

export async function chooseModelForProfile(
  cfg: Config,
  profile: RuntimeProfile,
  ctx: RuntimeRouteContext,
): Promise<ModelRouteDecision> {
  if (profile.kind === 'cursor-agent-cli') {
    // cursor-agent-cli 没有配置模型时，应让 Cursor Agent 自己按内部逻辑选模型，
    // 即 selectedModel 保持 undefined（CursorCliRuntime 遇到 falsy model 不会拼接
    // --model 参数）。之前这里用字面字符串 'Auto' 兜底，会被真实拼进 CLI 参数
    // （--model Auto），Cursor Agent 不认识该模型名，导致该次调用挂起无输出。
    return {
      mode: 'fixed',
      selectedModel: cfg.modelRouting.cursor.model ?? profile.model,
      reason: 'cursor-fixed-auto',
      complexityScore: complexityScore(cfg, ctx),
      availableModelCount: 1,
    };
  }
  if (profile.kind === 'gemini-cli') {
    return {
      mode: 'fixed',
      selectedModel: profile.model ?? 'auto',
      reason: 'gemini-fixed-model',
      complexityScore: complexityScore(cfg, ctx),
      availableModelCount: 1,
    };
  }
  if (profile.kind === 'openai-compatible') {
    return {
      mode: 'fixed',
      selectedModel: profile.model,
      reason: profile.model ? 'openai-fixed-model' : 'openai-fixed-default',
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

  const registry = await discoverRuntimeRegistry(cfg);
  const entry = registry.find(
    (item) => item.profile.bin === profile.bin && item.profile.kind === profile.kind,
  );
  if (!entry || entry.models.length === 0) {
    return {
      mode: 'smart',
      selectedModel: profile.model,
      reason: `kiro-smart-no-list(score=${score})`,
      complexityScore: score,
    };
  }

  const names = entry.models;
  const mediumThreshold = cfg.modelRouting.kiro.mediumThreshold;
  const hardThreshold = cfg.modelRouting.kiro.hardThreshold;

  let tier: 'simple' | 'medium' | 'hard' = 'simple';
  if (score >= hardThreshold) tier = 'hard';
  else if (score >= mediumThreshold) tier = 'medium';

  let selected: string | undefined;
  if (tier === 'hard') {
    selected =
      pickFirst(
        names,
        candidatesForTier(cfg.modelRouting.kiro.hardTier, ['claude-sonnet-5', 'claude-sonnet-4.6']),
      ) ?? entry.defaultModel;
  } else if (tier === 'medium') {
    selected =
      pickFirst(
        names,
        candidatesForTier(cfg.modelRouting.kiro.mediumTier, ['claude-opus-4.8', 'claude-opus-4.7']),
      ) ?? entry.defaultModel;
  } else {
    selected =
      pickFirst(names, candidatesForTier(cfg.modelRouting.kiro.simpleTier, ['claude-sonnet-5'])) ??
      entry.defaultModel;
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

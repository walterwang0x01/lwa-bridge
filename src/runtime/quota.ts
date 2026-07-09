/**
 * Runtime 配额探测与 fallback 排序（硬约束：depleted 不参与路由）。
 */
import type { Config } from '../lib/config.js';
import type { RuntimeKind, RuntimeProfile } from './types.js';
import type { TaskBucket } from './router.js';
import { probeNativeCliQuota } from './nativeQuotaProbe.js';

export type QuotaState = 'healthy' | 'depleted' | 'unknown' | 'error';

export interface QuotaStatus {
  runtimeKind: RuntimeKind;
  profileName?: string;
  state: QuotaState;
  remainingRatio?: number;
  detail?: string;
  checkedAt: string;
}

interface CacheEntry {
  status: QuotaStatus;
  expiresAt: number;
}

const probeCache = new Map<string, CacheEntry>();

export function clearQuotaProbeCache(): void {
  probeCache.clear();
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildStatus(
  runtimeKind: RuntimeKind,
  state: QuotaState,
  detail: string,
  remainingRatio?: number,
  profileName?: string,
): QuotaStatus {
  return {
    runtimeKind,
    profileName,
    state,
    remainingRatio,
    detail,
    checkedAt: nowIso(),
  };
}

export function isQuotaBlocked(status: QuotaStatus): boolean {
  return status.state === 'depleted' || status.state === 'error';
}

/** 按 bucket 的 profile 尝试顺序（profile 名，不是 runtime kind）。 */
export function fallbackProfilesForBucket(bucket: TaskBucket, cfg: Config): string[] {
  const custom = cfg.runtime?.quota?.fallbackByBucket?.[bucket];
  if (custom && custom.length > 0) return [...custom];
  switch (bucket) {
    case 'plan':
    case 'review':
    case 'conduit':
      return ['kiro', 'gemini', 'cursor'];
    default:
      return ['cursor', 'gemini', 'kiro'];
  }
}

export async function probeRuntimeQuota(
  profile: RuntimeProfile,
  profileName: string,
  cfg: Config,
  options?: { monthUsage?: number },
): Promise<QuotaStatus> {
  const override = cfg.runtime?.quota?.overrides?.[profile.kind];
  const limit = cfg.runtime?.quota?.monthlyLimits?.[profile.kind];
  const usage = options?.monthUsage;
  const cacheKey = `${profile.kind}:${profile.bin}:${override ?? '-'}:${limit ?? '-'}:${usage ?? '-'}`;
  const ttl = cfg.runtime?.quota?.cacheTtlMs ?? 10 * 60 * 1000;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.status, profileName };
  }

  if (override) {
    const status = buildStatus(profile.kind, override, 'config-override', undefined, profileName);
    probeCache.set(cacheKey, { status, expiresAt: Date.now() + ttl });
    return status;
  }

  if (limit !== undefined && usage !== undefined) {
    if (usage >= limit) {
      const status = buildStatus(
        profile.kind,
        'depleted',
        `monthly usage ${usage}/${limit}`,
        0,
        profileName,
      );
      probeCache.set(cacheKey, { status, expiresAt: Date.now() + ttl });
      return status;
    }
    const status = buildStatus(
      profile.kind,
      'healthy',
      `monthly usage ${usage}/${limit}`,
      Math.max(0, 1 - usage / limit),
      profileName,
    );
    probeCache.set(cacheKey, { status, expiresAt: Date.now() + ttl });
    return status;
  }

  const native = await probeNativeCliQuota(profile);
  if (native) {
    const status = buildStatus(
      profile.kind,
      native.state,
      native.detail,
      native.remainingRatio,
      profileName,
    );
    probeCache.set(cacheKey, { status, expiresAt: Date.now() + ttl });
    return status;
  }

  const status = buildStatus(
    profile.kind,
    'unknown',
    'no quota probe source',
    undefined,
    profileName,
  );
  probeCache.set(cacheKey, { status, expiresAt: Date.now() + ttl });
  return status;
}

export async function probeAllRuntimeQuotas(
  entries: Array<{ profileName: string; profile: RuntimeProfile }>,
  cfg: Config,
  monthUsageByKind?: Partial<Record<RuntimeKind, number>>,
): Promise<QuotaStatus[]> {
  const out: QuotaStatus[] = [];
  for (const entry of entries) {
    out.push(
      await probeRuntimeQuota(entry.profile, entry.profileName, cfg, {
        monthUsage: monthUsageByKind?.[entry.profile.kind],
      }),
    );
  }
  return out;
}

export function uniqueProfileOrder(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const name of group) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

export async function pickFirstQuotaOkProfile(
  profileNames: string[],
  available: Array<{ name: string; profile: RuntimeProfile }>,
  cfg: Config,
  monthUsageByKind?: Partial<Record<RuntimeKind, number>>,
): Promise<{ name: string; profile: RuntimeProfile; quota: QuotaStatus } | null> {
  for (const name of profileNames) {
    const hit = available.find((p) => p.name === name);
    if (!hit) continue;
    const quota = await probeRuntimeQuota(hit.profile, hit.name, cfg, {
      monthUsage: monthUsageByKind?.[hit.profile.kind],
    });
    if (!isQuotaBlocked(quota)) {
      return { name: hit.name, profile: hit.profile, quota };
    }
  }
  return null;
}

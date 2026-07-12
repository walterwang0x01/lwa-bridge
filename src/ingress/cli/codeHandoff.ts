/**
 * 解析 `lwa code` 原生 handoff 该用哪个 runtime profile。
 */
import type { Config } from '../../lib/config.js';
import { resolveRuntimeProfile } from '../../runtime/config.js';
import { PLAN_PRESETS, resolvePlanId } from '../../runtime/planProfiles.js';
import type { RuntimeProfile } from '../../runtime/types.js';

export interface ResolvedCodeHandoffProfile {
  profileName: string;
  profile: RuntimeProfile;
}

/**
 * 优先 sticky；否则用套餐 code.complexProfile（kiro-unlimited 默认 kiro）。
 * sticky 为 auto 时也回落到 complexProfile。
 */
export function resolveCodeHandoffProfile(
  config: Config,
  stickyProfileName?: string | null,
): ResolvedCodeHandoffProfile {
  const sticky = stickyProfileName?.trim();
  if (sticky && sticky !== 'auto') {
    try {
      return { profileName: sticky, profile: resolveRuntimeProfile(config, sticky) };
    } catch {
      // fall through
    }
  }
  const plan = PLAN_PRESETS[resolvePlanId(config)];
  const name = plan.code.complexProfile || 'kiro';
  return { profileName: name, profile: resolveRuntimeProfile(config, name) };
}

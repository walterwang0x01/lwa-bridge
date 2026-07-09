/**
 * Best-effort native CLI quota probes (kiro-cli usage / gemini quota).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeProfile } from './types.js';
import type { QuotaState } from './quota.js';

const execFileAsync = promisify(execFile);

export interface NativeQuotaResult {
  state: QuotaState;
  detail: string;
  remainingRatio?: number;
}

interface UsageJson {
  depleted?: boolean;
  remaining?: number;
  limit?: number;
  remaining_ratio?: number;
}

function parseUsagePayload(data: UsageJson, source: string): NativeQuotaResult | null {
  if (data.depleted === true) {
    return { state: 'depleted', detail: source, remainingRatio: 0 };
  }
  if (typeof data.remaining === 'number' && typeof data.limit === 'number' && data.limit > 0) {
    const remainingRatio = Math.max(0, Math.min(1, data.remaining / data.limit));
    return {
      state: remainingRatio <= 0 ? 'depleted' : 'healthy',
      detail: `${source} remaining=${data.remaining}/${data.limit}`,
      remainingRatio,
    };
  }
  if (typeof data.remaining_ratio === 'number') {
    const remainingRatio = Math.max(0, Math.min(1, data.remaining_ratio));
    return {
      state: remainingRatio <= 0 ? 'depleted' : 'healthy',
      detail: source,
      remainingRatio,
    };
  }
  return null;
}

async function runJsonProbe(bin: string, args: string[]): Promise<UsageJson | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 8_000 });
    const data = JSON.parse(stdout) as UsageJson;
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export async function probeNativeCliQuota(
  profile: RuntimeProfile,
): Promise<NativeQuotaResult | null> {
  if (profile.kind === 'cursor-agent-cli') {
    return null;
  }
  if (profile.kind === 'kiro-cli-acp') {
    const data = await runJsonProbe(profile.bin, ['usage', '--json']);
    if (data) {
      return parseUsagePayload(data, 'kiro-cli usage --json');
    }
  }
  if (profile.kind === 'gemini-cli') {
    const data = await runJsonProbe(profile.bin, ['quota', '--json']);
    if (data) {
      return parseUsagePayload(data, 'gemini quota --json');
    }
  }
  return null;
}

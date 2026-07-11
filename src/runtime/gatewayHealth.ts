/**
 * OpenAI 兼容网关健康检查 + 简易熔断。
 * 不健康时路由层可跳过 openai-* profile，fallback 到 kiro/cursor。
 */
import type { RuntimeProfile } from './types.js';
import { listOpenAIModels } from './openaiModels.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitEntry {
  failures: number;
  openedAt?: number;
  state: CircuitState;
  lastError?: string;
  lastOkAt?: number;
}

export interface GatewayHealthOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  probeTimeoutMs?: number;
}

const DEFAULTS = {
  failureThreshold: 2,
  cooldownMs: 60_000,
  probeTimeoutMs: 3_000,
};

function profileKey(profile: RuntimeProfile, name?: string): string {
  const base = profile.apiBase ?? process.env['OPENAI_API_BASE'] ?? 'unknown';
  return name ? `${name}|${base}` : base;
}

export class GatewayHealth {
  private readonly circuits = new Map<string, CircuitEntry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly probeTimeoutMs: number;

  constructor(opts?: GatewayHealthOptions) {
    this.failureThreshold = opts?.failureThreshold ?? DEFAULTS.failureThreshold;
    this.cooldownMs = opts?.cooldownMs ?? DEFAULTS.cooldownMs;
    this.probeTimeoutMs = opts?.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs;
  }

  getState(profile: RuntimeProfile, name?: string): CircuitState {
    const key = profileKey(profile, name);
    const entry = this.circuits.get(key);
    if (!entry) return 'closed';
    if (
      entry.state === 'open' &&
      entry.openedAt &&
      Date.now() - entry.openedAt >= this.cooldownMs
    ) {
      entry.state = 'half-open';
      return 'half-open';
    }
    return entry.state;
  }

  /** 熔断打开时返回 false（half-open 允许探测一次）。 */
  allows(profile: RuntimeProfile, name?: string): boolean {
    const state = this.getState(profile, name);
    return state !== 'open';
  }

  recordSuccess(profile: RuntimeProfile, name?: string): void {
    const key = profileKey(profile, name);
    this.circuits.set(key, {
      failures: 0,
      state: 'closed',
      lastOkAt: Date.now(),
    });
  }

  recordFailure(profile: RuntimeProfile, name?: string, error?: string): void {
    const key = profileKey(profile, name);
    const prev = this.circuits.get(key) ?? { failures: 0, state: 'closed' as CircuitState };
    const failures = prev.failures + 1;
    if (failures >= this.failureThreshold || prev.state === 'half-open') {
      this.circuits.set(key, {
        failures,
        state: 'open',
        openedAt: Date.now(),
        lastError: error,
      });
      return;
    }
    this.circuits.set(key, {
      failures,
      state: 'closed',
      lastError: error,
    });
  }

  /**
   * 主动探测 GET /models。成功则关断路，失败则记失败。
   * 已 open 且未到 cooldown 时直接返回 false，不打网关。
   */
  async probe(profile: RuntimeProfile, name?: string): Promise<{ ok: boolean; detail?: string }> {
    if (profile.kind !== 'openai-compatible') {
      return { ok: true };
    }
    const state = this.getState(profile, name);
    if (state === 'open') {
      const entry = this.circuits.get(profileKey(profile, name));
      return { ok: false, detail: entry?.lastError ?? 'circuit open' };
    }

    const raced = await Promise.race([
      listOpenAIModels(profile),
      new Promise<{ models: string[]; error?: string }>((resolve) =>
        setTimeout(
          () => resolve({ models: [], error: `probe timeout ${this.probeTimeoutMs}ms` }),
          this.probeTimeoutMs,
        ),
      ),
    ]);

    if (raced.error || raced.models.length === 0) {
      const detail = raced.error ?? 'empty models';
      this.recordFailure(profile, name, detail);
      return { ok: false, detail };
    }
    this.recordSuccess(profile, name);
    return { ok: true, detail: `${raced.models.length} models` };
  }

  /** 测试用：清空状态 */
  reset(): void {
    this.circuits.clear();
  }

  snapshot(): Array<{ key: string; state: CircuitState; failures: number; lastError?: string }> {
    const out: Array<{ key: string; state: CircuitState; failures: number; lastError?: string }> =
      [];
    for (const [key, e] of this.circuits.entries()) {
      let state = e.state;
      if (state === 'open' && e.openedAt && Date.now() - e.openedAt >= this.cooldownMs) {
        state = 'half-open';
      }
      out.push({ key, state, failures: e.failures, lastError: e.lastError });
    }
    return out;
  }
}

/** 进程级单例，供路由与 dispatcher 共享。 */
export const sharedGatewayHealth = new GatewayHealth();

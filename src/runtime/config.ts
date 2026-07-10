/**
 * runtime profile 解析：从 Config 合并 legacy kiro.* 字段。
 */
import type { Config } from '../lib/config.js';
import type { RuntimeKind, RuntimeProfile } from './types.js';

const DEFAULT_BINS: Record<RuntimeKind, string> = {
  'kiro-cli-acp': 'kiro-cli',
  'cursor-agent-cli': 'agent',
  'gemini-cli': 'gemini',
  'openai-compatible': 'openai-compatible',
};

export function profileNameForRuntimeKind(kind: string): string {
  switch (kind) {
    case 'cursor-agent-cli':
      return 'cursor';
    case 'gemini-cli':
      return 'gemini';
    case 'openai-compatible':
      return 'openai';
    case 'kiro-cli-acp':
    default:
      return 'kiro';
  }
}

export function defaultRuntimeProfiles(cfg: Config): {
  kiro: RuntimeProfile;
  cursor: RuntimeProfile;
  gemini: RuntimeProfile;
  openai: RuntimeProfile;
} & Record<string, RuntimeProfile> {
  const kiro: RuntimeProfile = {
    kind: 'kiro-cli-acp',
    bin: cfg.kiro.binPath,
    model: cfg.kiro.model,
    agent: cfg.kiro.agent,
    timeoutMs: cfg.kiro.timeoutMs,
    idleTimeoutMinutes: cfg.kiro.idleTimeoutMinutes,
    systemPromptPrefix: cfg.kiro.systemPromptPrefix,
    trustedTools: cfg.kiro.trustedTools,
  };
  const cursor: RuntimeProfile = {
    kind: 'cursor-agent-cli',
    bin: DEFAULT_BINS['cursor-agent-cli'],
    model: 'Auto',
    force: true,
    timeoutMs: cfg.kiro.timeoutMs,
    idleTimeoutMinutes: cfg.kiro.idleTimeoutMinutes,
    systemPromptPrefix: cfg.kiro.systemPromptPrefix,
  };
  const gemini: RuntimeProfile = {
    kind: 'gemini-cli',
    bin: DEFAULT_BINS['gemini-cli'],
    model: 'auto',
    force: true,
    timeoutMs: cfg.kiro.timeoutMs,
    idleTimeoutMinutes: cfg.kiro.idleTimeoutMinutes,
    systemPromptPrefix: cfg.kiro.systemPromptPrefix,
  };
  const openai: RuntimeProfile = {
    kind: 'openai-compatible',
    bin: DEFAULT_BINS['openai-compatible'],
    model: process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
    apiBase: process.env['OPENAI_API_BASE'],
    apiKey: process.env['OPENAI_API_KEY'],
    timeoutMs: cfg.kiro.timeoutMs,
    idleTimeoutMinutes: cfg.kiro.idleTimeoutMinutes,
    systemPromptPrefix: cfg.kiro.systemPromptPrefix,
  };
  return { kiro, cursor, gemini, openai };
}

export function listRuntimeProfileNames(cfg: Config): string[] {
  const merged = { ...defaultRuntimeProfiles(cfg), ...(cfg.runtime?.profiles ?? {}) };
  return Object.keys(merged);
}

export function resolveRuntimeProfile(cfg: Config, profileName?: string): RuntimeProfile {
  const name = profileName ?? cfg.runtime?.default ?? 'kiro';
  const defaults = defaultRuntimeProfiles(cfg);
  const custom = cfg.runtime?.profiles?.[name];
  const kiroDefault = defaults.kiro;
  const named = defaults[name];
  const base = named ?? kiroDefault;
  if (!custom) {
    if (!named && name !== 'kiro') {
      throw new Error(`Unknown runtime profile: ${name}`);
    }
    return base;
  }
  const kind = custom.kind ?? base.kind;
  return {
    ...base,
    ...custom,
    kind,
    bin: custom.bin ?? base.bin ?? DEFAULT_BINS[kind],
  };
}

export function runtimeProfileForCommand(cfg: Config, command: string): string | undefined {
  return cfg.runtime?.routing?.commands?.[command];
}

export function effectiveSystemPromptPrefix(profile: RuntimeProfile, cfg: Config): string {
  return profile.systemPromptPrefix ?? cfg.kiro.systemPromptPrefix ?? '';
}

export function effectiveTimeoutMs(profile: RuntimeProfile, cfg: Config): number {
  return profile.timeoutMs ?? cfg.kiro.timeoutMs;
}

export function effectiveIdleMinutes(profile: RuntimeProfile, cfg: Config): number {
  return profile.idleTimeoutMinutes ?? cfg.kiro.idleTimeoutMinutes;
}

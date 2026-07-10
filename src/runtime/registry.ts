import { spawnSync } from 'node:child_process';
import type { Config } from '../lib/config.js';
import { listModels } from '../kiro/models.js';
import { listOpenAIModels } from './openaiModels.js';
import { defaultRuntimeProfiles, resolveRuntimeProfile } from './config.js';
import type { RuntimeProfile } from './types.js';

export interface RuntimeRegistryEntry {
  profileName: string;
  profile: RuntimeProfile;
  available: boolean;
  detail?: string;
  defaultModel?: string;
  models: string[];
}

function isBinAvailable(bin: string): boolean {
  const res = spawnSync('which', [bin], { stdio: 'ignore' });
  return res.status === 0;
}

function availabilityOfProfile(profile: RuntimeProfile): { available: boolean; detail?: string } {
  if (profile.kind === 'openai-compatible') {
    const missing: string[] = [];
    if (!profile.apiBase) missing.push('apiBase');
    if (!profile.apiKey) missing.push('apiKey');
    if (!profile.model) missing.push('model');
    if (missing.length > 0) {
      return { available: false, detail: `missing ${missing.join(', ')}` };
    }
    const apiBase = profile.apiBase!;
    let host = apiBase;
    try {
      host = new URL(apiBase).host;
    } catch {
      // keep original apiBase string
    }
    return { available: true, detail: `gateway ${host}` };
  }
  return isBinAvailable(profile.bin)
    ? { available: true, detail: `bin ${profile.bin}` }
    : { available: false, detail: `bin not found: ${profile.bin}` };
}

export async function discoverRuntimeRegistry(cfg: Config): Promise<RuntimeRegistryEntry[]> {
  const names = Object.keys({ ...defaultRuntimeProfiles(cfg), ...(cfg.runtime?.profiles ?? {}) });
  const results: RuntimeRegistryEntry[] = [];
  for (const profileName of names) {
    const profile = resolveRuntimeProfile(cfg, profileName);
    const availability = availabilityOfProfile(profile);
    const available = availability.available;
    let defaultModel: string | undefined;
    let models: string[] = [];
    if (available && profile.kind === 'kiro-cli-acp') {
      const listed = await listModels(profile.bin);
      defaultModel = listed?.defaultModel;
      models = listed?.models.map((m) => m.name) ?? [];
    } else if (available && profile.kind === 'openai-compatible') {
      const listed = await listOpenAIModels(profile);
      defaultModel = listed.defaultModel ?? profile.model;
      models = listed.models;
      if (listed.error && models.length === 0) {
        results.push({
          profileName,
          profile,
          available,
          detail: `${availability.detail ?? 'ok'}; models: ${listed.error}`,
          defaultModel,
          models,
        });
        continue;
      }
    }
    results.push({
      profileName,
      profile,
      available,
      detail: availability.detail,
      defaultModel,
      models,
    });
  }
  return results;
}

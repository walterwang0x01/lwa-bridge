import { spawnSync } from 'node:child_process';
import type { Config } from '../lib/config.js';
import { listModels } from '../kiro/models.js';
import { defaultRuntimeProfiles, resolveRuntimeProfile } from './config.js';
import type { RuntimeProfile } from './types.js';

export interface RuntimeRegistryEntry {
  profileName: string;
  profile: RuntimeProfile;
  available: boolean;
  defaultModel?: string;
  models: string[];
}

function isBinAvailable(bin: string): boolean {
  const res = spawnSync('which', [bin], { stdio: 'ignore' });
  return res.status === 0;
}

export async function discoverRuntimeRegistry(cfg: Config): Promise<RuntimeRegistryEntry[]> {
  const names = Object.keys({ ...defaultRuntimeProfiles(cfg), ...(cfg.runtime?.profiles ?? {}) });
  const results: RuntimeRegistryEntry[] = [];
  for (const profileName of names) {
    const profile = resolveRuntimeProfile(cfg, profileName);
    const available = isBinAvailable(profile.bin);
    let defaultModel: string | undefined;
    let models: string[] = [];
    if (available && profile.kind === 'kiro-cli-acp') {
      const listed = await listModels(profile.bin);
      defaultModel = listed?.defaultModel;
      models = listed?.models.map((m) => m.name) ?? [];
    }
    results.push({ profileName, profile, available, defaultModel, models });
  }
  return results;
}

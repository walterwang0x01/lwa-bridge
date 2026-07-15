/**
 * CLI /model 统一选择：Auto + 各引擎 + gateway 模型 + kiro 模型。
 * 顺序刻意：引擎/gateway 在前，避免长 kiro 列表淹没入口。
 */
import type { Config } from '../../lib/config.js';
import { listModels } from '../../kiro/models.js';
import { discoverRuntimeRegistry } from '../../runtime/registry.js';
import { listRuntimeProfileNames, resolveRuntimeProfile } from '../../runtime/config.js';
import type { PickListItem } from './slashPicker.js';

export type ModelPick =
  | { kind: 'engine'; name: string }
  | { kind: 'kiro-model'; name: string }
  | { kind: 'openai-model'; profile: string; model: string };

const SEP = '\x1e';

export function encodeModelPick(p: ModelPick): string {
  if (p.kind === 'engine') return `e${SEP}${p.name}`;
  if (p.kind === 'kiro-model') return `k${SEP}${p.name}`;
  return `o${SEP}${p.profile}${SEP}${p.model}`;
}

export function decodeModelPick(raw: string): ModelPick | null {
  const parts = raw.split(SEP);
  if (parts[0] === 'e' && parts[1]) return { kind: 'engine', name: parts[1] };
  if (parts[0] === 'k' && parts[1]) return { kind: 'kiro-model', name: parts[1] };
  if (parts[0] === 'o' && parts[1] && parts[2]) {
    return { kind: 'openai-model', profile: parts[1], model: parts.slice(2).join(SEP) };
  }
  return null;
}

export async function buildUnifiedModelPickerItems(opts: {
  config: Config;
  currentProfileName: string;
  routeMode: string;
}): Promise<PickListItem[]> {
  const { config, currentProfileName, routeMode } = opts;
  const items: PickListItem[] = [];
  const currentKiroModel = config.kiro.model;

  items.push({
    value: encodeModelPick({ kind: 'engine', name: 'auto' }),
    label: 'Auto',
    hint: routeMode === 'Auto' ? '← current · smart route' : 'clear sticky · smart route',
  });

  // 引擎先行（cursor / kiro / openai-* / gemini）
  for (const name of listRuntimeProfileNames(config)) {
    try {
      const p = resolveRuntimeProfile(config, name);
      const active = name === currentProfileName && routeMode !== 'Auto';
      let hint: string = p.kind;
      if (p.kind === 'cursor-agent-cli') hint = 'cursor · Auto inside agent';
      else if (p.kind === 'openai-compatible') hint = `gateway · ${p.model ?? '-'}`;
      else if (p.kind === 'kiro-cli-acp') hint = `kiro · ${p.model ?? currentKiroModel ?? 'auto'}`;
      else if (p.model) hint = `${p.kind} · ${p.model}`;
      if (active) hint = `← current · ${hint}`;
      items.push({
        value: encodeModelPick({ kind: 'engine', name }),
        label: `[engine] ${name}`,
        hint,
      });
    } catch {
      items.push({
        value: encodeModelPick({ kind: 'engine', name }),
        label: `[engine] ${name}`,
        hint: 'unavailable',
      });
    }
  }

  // gateway 模型（放在 kiro 长列表之前）
  try {
    const registry = await discoverRuntimeRegistry(config);
    let gatewayHits = 0;
    for (const entry of registry) {
      if (entry.profile.kind !== 'openai-compatible') continue;
      if (!entry.available && !entry.profile.model) {
        items.push({
          value: encodeModelPick({
            kind: 'engine',
            name: entry.profileName,
          }),
          label: `[gateway] ${entry.profileName}`,
          hint: entry.detail ?? 'unavailable',
        });
        continue;
      }
      if (!entry.models.length) {
        if (entry.profile.model) {
          gatewayHits += 1;
          items.push({
            value: encodeModelPick({
              kind: 'openai-model',
              profile: entry.profileName,
              model: entry.profile.model,
            }),
            label: `[gateway] ${entry.profileName} · ${entry.profile.model}`,
            hint: entry.available ? 'configured' : (entry.detail ?? 'unavailable'),
          });
        }
        continue;
      }
      const cur = entry.profile.model ?? entry.defaultModel;
      for (const mid of entry.models.slice(0, 10)) {
        gatewayHits += 1;
        items.push({
          value: encodeModelPick({
            kind: 'openai-model',
            profile: entry.profileName,
            model: mid,
          }),
          label: `[gateway] ${entry.profileName} · ${mid}`,
          hint: mid === cur ? '← current' : undefined,
        });
      }
    }
    if (gatewayHits === 0) {
      items.push({
        value: encodeModelPick({ kind: 'engine', name: 'openai-fast' }),
        label: '[gateway] (no models discovered)',
        hint: 'check apiBase/apiKey · /runtime check',
      });
    }
  } catch (e) {
    items.push({
      value: encodeModelPick({ kind: 'engine', name: 'openai' }),
      label: '[gateway] discovery failed',
      hint: e instanceof Error ? e.message.slice(0, 40) : 'error',
    });
  }

  // kiro 模型（截断，避免淹没前面选项）
  try {
    const kiro = resolveRuntimeProfile(config, 'kiro');
    const list = await listModels(kiro.bin || config.kiro.binPath);
    if (list?.models.length) {
      items.push({
        value: encodeModelPick({ kind: 'kiro-model', name: 'auto' }),
        label: '[kiro] auto',
        hint: 'reset kiro model override',
      });
      const cur = currentKiroModel ?? list.defaultModel;
      for (const m of list.models.slice(0, 15)) {
        items.push({
          value: encodeModelPick({ kind: 'kiro-model', name: m.name }),
          label: `[kiro] ${m.name}`,
          hint: m.name === cur ? '← current model' : undefined,
        });
      }
      if (list.models.length > 15) {
        items.push({
          value: encodeModelPick({ kind: 'kiro-model', name: list.models[15]!.name }),
          label: `[kiro] … +${list.models.length - 15} more`,
          hint: 'type /model <name> for the rest',
        });
      }
    }
  } catch {
    // ignore
  }

  return items;
}

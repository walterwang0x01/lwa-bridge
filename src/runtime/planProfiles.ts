/**
 * 套餐感知路由预设：按用户 Cursor/Kiro/网关约束选择默认策略。
 *
 * - kiro-unlimited+cursor-lite：code 以 kiro 为主，cursor 做轻量；网关可选+熔断
 * - cursor-heavy：以 cursor 为主
 * - gateway-first：以 openai-compatible 为主（网关稳时）
 */
import type { Config } from '../lib/config.js';
import type { TaskBucket } from './router.js';

export type PlanId = 'kiro-unlimited+cursor-lite' | 'cursor-heavy' | 'gateway-first';
export type HarnessMode = 'code' | 'chat' | 'lark';

export interface ModeRouteTable {
  /** smart 模式下的简单任务 profile */
  simpleProfile: string;
  /** smart 模式下的复杂任务 profile */
  complexProfile: string;
  /** conduit / 长链路 */
  conduitProfile: string;
  /** fallback 顺序 */
  fallbackProfiles: string[];
  /** 分桶 fallback（可选覆盖） */
  fallbackByBucket?: Partial<Record<TaskBucket, string[]>>;
  /** 自动选中后是否粘性锁定到会话 */
  sticky: boolean;
  /** openai-compatible 不健康时从候选中剔除 */
  gatewayOptional: boolean;
}

export interface PlanPreset {
  id: PlanId;
  label: string;
  code: ModeRouteTable;
  chat: ModeRouteTable;
  lark: ModeRouteTable;
}

const KIRO_LITE: PlanPreset = {
  id: 'kiro-unlimited+cursor-lite',
  label: 'Kiro 主力 + Cursor 省钱 + 网关旁路',
  code: {
    simpleProfile: 'cursor',
    complexProfile: 'kiro',
    conduitProfile: 'kiro',
    fallbackProfiles: ['kiro', 'cursor', 'openai-fast', 'openai-strong'],
    fallbackByBucket: {
      chat: ['cursor', 'kiro', 'openai-fast'],
      edit: ['kiro', 'cursor', 'openai-strong'],
      plan: ['kiro', 'openai-strong', 'cursor'],
      review: ['kiro', 'openai-strong', 'cursor'],
      conduit: ['kiro', 'cursor'],
    },
    sticky: true,
    gatewayOptional: true,
  },
  chat: {
    simpleProfile: 'openai-fast',
    complexProfile: 'kiro',
    conduitProfile: 'kiro',
    fallbackProfiles: ['kiro', 'cursor', 'openai-fast', 'openai-strong'],
    sticky: true,
    gatewayOptional: true,
  },
  lark: {
    simpleProfile: 'openai-fast',
    complexProfile: 'kiro',
    conduitProfile: 'kiro',
    fallbackProfiles: ['kiro', 'cursor', 'openai-fast', 'openai-strong'],
    sticky: false,
    gatewayOptional: true,
  },
};

const CURSOR_HEAVY: PlanPreset = {
  id: 'cursor-heavy',
  label: 'Cursor 主力',
  code: {
    simpleProfile: 'cursor',
    complexProfile: 'cursor',
    conduitProfile: 'kiro',
    fallbackProfiles: ['cursor', 'kiro', 'openai-strong'],
    sticky: true,
    gatewayOptional: true,
  },
  chat: {
    simpleProfile: 'cursor',
    complexProfile: 'kiro',
    conduitProfile: 'kiro',
    fallbackProfiles: ['cursor', 'kiro', 'openai-fast'],
    sticky: true,
    gatewayOptional: true,
  },
  lark: {
    simpleProfile: 'cursor',
    complexProfile: 'kiro',
    conduitProfile: 'kiro',
    fallbackProfiles: ['cursor', 'kiro', 'openai-fast'],
    sticky: false,
    gatewayOptional: true,
  },
};

const GATEWAY_FIRST: PlanPreset = {
  id: 'gateway-first',
  label: 'OpenAPI 网关优先',
  code: {
    simpleProfile: 'openai-fast',
    complexProfile: 'openai-strong',
    conduitProfile: 'kiro',
    fallbackProfiles: ['openai-fast', 'openai-strong', 'kiro', 'cursor'],
    sticky: true,
    gatewayOptional: true,
  },
  chat: {
    simpleProfile: 'openai-fast',
    complexProfile: 'openai-strong',
    conduitProfile: 'kiro',
    fallbackProfiles: ['openai-fast', 'openai-strong', 'kiro', 'cursor'],
    sticky: true,
    gatewayOptional: true,
  },
  lark: {
    simpleProfile: 'openai-fast',
    complexProfile: 'openai-strong',
    conduitProfile: 'kiro',
    fallbackProfiles: ['openai-fast', 'openai-strong', 'kiro', 'cursor'],
    sticky: false,
    gatewayOptional: true,
  },
};

export const PLAN_PRESETS: Record<PlanId, PlanPreset> = {
  'kiro-unlimited+cursor-lite': KIRO_LITE,
  'cursor-heavy': CURSOR_HEAVY,
  'gateway-first': GATEWAY_FIRST,
};

export function resolvePlanId(cfg: Config): PlanId {
  const raw = cfg.runtime?.plan;
  if (raw && raw in PLAN_PRESETS) return raw as PlanId;
  return 'kiro-unlimited+cursor-lite';
}

function mergeModeTable(base: ModeRouteTable, override?: Partial<ModeRouteTable>): ModeRouteTable {
  if (!override) return base;
  return {
    simpleProfile: override.simpleProfile ?? base.simpleProfile,
    complexProfile: override.complexProfile ?? base.complexProfile,
    conduitProfile: override.conduitProfile ?? base.conduitProfile,
    fallbackProfiles: override.fallbackProfiles ?? base.fallbackProfiles,
    fallbackByBucket: override.fallbackByBucket ?? base.fallbackByBucket,
    sticky: override.sticky ?? base.sticky,
    gatewayOptional: override.gatewayOptional ?? base.gatewayOptional,
  };
}

/** 解析某 harness 模式的路由表（plan 预设 + legacy router.lark + config.runtime.modes）。 */
export function resolveModeRouteTable(cfg: Config, mode: HarnessMode): ModeRouteTable {
  const preset = PLAN_PRESETS[resolvePlanId(cfg)];
  let base = preset[mode];

  // 飞书 Gateway：继续尊重 runtime.router.lark（用户现有配置）
  if (mode === 'lark' && cfg.runtime?.router?.lark) {
    const l = cfg.runtime.router.lark;
    base = mergeModeTable(base, {
      simpleProfile: l.simpleProfile,
      complexProfile: l.complexProfile,
      conduitProfile: l.conduitProfile,
    });
  }
  if (mode === 'lark' && cfg.runtime?.router?.fallbackProfiles?.length) {
    base = {
      ...base,
      fallbackProfiles: [
        ...cfg.runtime.router.fallbackProfiles,
        ...base.fallbackProfiles.filter((p) => !cfg.runtime!.router!.fallbackProfiles.includes(p)),
      ],
    };
  }

  const modes = cfg.runtime?.modes;
  if (!modes) return base;
  if (mode === 'code') return mergeModeTable(base, modes.code);
  if (mode === 'chat') return mergeModeTable(base, modes.chat);
  return mergeModeTable(base, modes.lark);
}

export function listPlanIds(): PlanId[] {
  return Object.keys(PLAN_PRESETS) as PlanId[];
}

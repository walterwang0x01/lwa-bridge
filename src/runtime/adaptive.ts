/**
 * Adaptive routing 阈值（Bridge dispatcher 与 Dashboard 共用）。
 */
export const APPLY_SAFE_MIN_SAMPLE = 8;
export const APPLY_SAFE_MIN_SUCCESS_RATE = 0.9;

/** 文档建议：切 apply-safe 前每桶至少积累多少条（见 runtime-routing-production.md） */
export const APPLY_SAFE_ROLLOUT_MIN_SAMPLE = 30;

export interface ApplySafeGateResult {
  canApplyRuntime: boolean;
  canApplyModel: boolean;
}

export function evaluateApplySafeGates(input: {
  sampleSize: number;
  runtimeSuccessRate?: number;
  modelSuccessRate?: number;
}): ApplySafeGateResult {
  const meetsSample = input.sampleSize >= APPLY_SAFE_MIN_SAMPLE;
  const runtimeOk = (input.runtimeSuccessRate ?? 0) >= APPLY_SAFE_MIN_SUCCESS_RATE;
  const modelOk = (input.modelSuccessRate ?? 0) >= APPLY_SAFE_MIN_SUCCESS_RATE;
  return {
    canApplyRuntime: meetsSample && runtimeOk,
    canApplyModel: meetsSample && modelOk,
  };
}

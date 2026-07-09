import { describe, expect, it } from 'vitest';
import {
  APPLY_SAFE_MIN_SAMPLE,
  APPLY_SAFE_MIN_SUCCESS_RATE,
  evaluateApplySafeGates,
} from './adaptive.js';

describe('evaluateApplySafeGates', () => {
  it('requires sample and success thresholds for apply-safe', () => {
    expect(
      evaluateApplySafeGates({
        sampleSize: APPLY_SAFE_MIN_SAMPLE,
        runtimeSuccessRate: APPLY_SAFE_MIN_SUCCESS_RATE,
        modelSuccessRate: APPLY_SAFE_MIN_SUCCESS_RATE,
      }),
    ).toEqual({ canApplyRuntime: true, canApplyModel: true });

    expect(
      evaluateApplySafeGates({
        sampleSize: APPLY_SAFE_MIN_SAMPLE - 1,
        runtimeSuccessRate: 1,
        modelSuccessRate: 1,
      }),
    ).toEqual({ canApplyRuntime: false, canApplyModel: false });

    expect(
      evaluateApplySafeGates({
        sampleSize: 20,
        runtimeSuccessRate: 0.89,
        modelSuccessRate: 0.95,
      }),
    ).toEqual({ canApplyRuntime: false, canApplyModel: true });
  });
});

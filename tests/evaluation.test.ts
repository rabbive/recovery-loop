import { describe, expect, it } from 'vitest';
import { generateEvaluationCases, runEvaluation } from '../src/evaluation.js';

describe('synthetic evaluation', () => {
  it('is reproducible and covers at least 50 cases', async () => {
    const first = await runEvaluation(generateEvaluationCases(60, 42));
    const second = await runEvaluation(generateEvaluationCases(60, 42));
    expect(first.totalCases).toBe(60);
    expect(first.revenueAtRisk).toBe(second.revenueAtRisk);
    expect(first.recoveredAmount).toBe(second.recoveredAmount);
    expect(first.recoveryRate).toBeGreaterThan(0);
    expect(first.fallbackRecoveryRate).toBeGreaterThan(0);
    expect(first.exhaustedRate).toBeGreaterThan(0);
    expect(first.diagnosisAccuracy).toBeGreaterThan(0.5);
  });
});

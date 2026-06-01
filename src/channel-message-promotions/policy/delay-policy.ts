import type { DelayResult, HealthDelayInput } from './policy.types';
import { safeNonNegative, safeSessionRate, safeUnitRandom } from './policy-number-utils';

export function calculateHealthBasedPromotionDelay(input: HealthDelayInput): DelayResult {
  const malformedInput = !isRecord(input);
  const safeInput = malformedInput ? {} : input as Partial<HealthDelayInput>;
  const {
    successCount = 0,
    failedCount = 0,
    failStreak = 0,
    random = malformedInput ? (() => 0.5) : Math.random,
  } = safeInput;
  const sessionRate = safeSessionRate(successCount, failedCount);
  const safeFailStreak = safeNonNegative(failStreak);

  if (sessionRate > 0.8 && safeFailStreak === 0) {
    return {
      delayMs: 14 * 60 * 1000 + symmetricJitter(2 * 60 * 1000, random),
      sessionRate,
      mode: 'healthy',
    };
  }

  if (sessionRate < 0.4 || safeFailStreak > 5) {
    return {
      delayMs: Math.max(60_000, 3 * 60 * 1000 + symmetricJitter(60 * 1000, random)),
      sessionRate,
      mode: 'degraded',
    };
  }

  return {
    delayMs: 8 * 60 * 1000 + symmetricJitter(90 * 1000, random),
    sessionRate,
    mode: 'normal',
  };
}

export function symmetricJitter(rangeMs: number, random: () => number): number {
  const safeRangeMs = safeNonNegative(rangeMs);
  return Math.floor(safeUnitRandom(random) * (2 * safeRangeMs)) - safeRangeMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

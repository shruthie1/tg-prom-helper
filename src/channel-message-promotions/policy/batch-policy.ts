import type { BatchLimitInput, BatchLimitResult } from './policy.types';
import { safeNonNegative, safeSessionRate, safeUnitRandom } from './policy-number-utils';

export function calculatePromotionBatchLimit(input: BatchLimitInput): BatchLimitResult {
  const malformedInput = !isRecord(input);
  const safeInput = malformedInput ? {} : input as Partial<BatchLimitInput>;
  const {
    scoringEnabled,
    daysLeft = 0,
    successCount = 0,
    failedCount = 0,
    failStreak = 0,
    random = malformedInput ? (() => 0.5) : Math.random,
    includeJitter = false,
  } = safeInput;
  const safeDaysLeft = safeNonNegative(daysLeft);
  const safeFailStreak = safeNonNegative(failStreak);
  const sessionRate = safeSessionRate(successCount, failedCount);

  if (scoringEnabled !== true) {
    const limit = safeDaysLeft > 0
      ? 160 + Math.floor(safeUnitRandom(random) * 41)
      : 100 + Math.floor(safeUnitRandom(random) * 51);
    return { limit, sessionRate, healthMultiplier: null };
  }

  let healthMultiplier: number;
  if (safeDaysLeft > 0) {
    if (sessionRate > 0.8 && safeFailStreak === 0) {
      healthMultiplier = 0.75;
    } else if (sessionRate < 0.4 || safeFailStreak > 5) {
      healthMultiplier = 1.3;
    } else {
      healthMultiplier = 1.0;
    }
  } else {
    healthMultiplier = 1.2;
  }

  const jitter = includeJitter ? Math.floor(safeUnitRandom(random) * 21) : 0;
  return {
    limit: Math.round(140 * healthMultiplier) + jitter,
    sessionRate,
    healthMultiplier,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

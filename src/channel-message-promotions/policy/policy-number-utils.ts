export function safeNonNegative(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function safeSessionRate(successCount: number, failedCount: number): number {
  const successes = safeNonNegative(successCount);
  const failures = safeNonNegative(failedCount);
  return successes / Math.max(1, successes + failures);
}

export function safeUnitRandom(random: () => number): number {
  try {
    const value = random();
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(0.999999999, value));
  } catch {
    return 0.5;
  }
}

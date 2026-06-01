/**
 * Discounted Thompson Sampling for message strategy selection.
 * Ported from tg-aut's message-strategy-selector.ts.
 *
 * Uses Beta(alpha, beta) sampling via gamma distribution (Marsaglia's method).
 * Discount factor gamma=0.995 ensures recent performance weighs more.
 */

import type { MessageStrategy, StrategyArm, ChannelIntelligenceDocument } from '../channel-intelligence/channel-intelligence.types';

export { type MessageStrategy };

export const COLD_START_THRESHOLD = 10;

interface ArmState {
  strategy: MessageStrategy;
  successes: number;
  failures: number;
  totalPulls: number;
}

export interface StrategyStats {
  successes: number;
  failures: number;
  totalPulls: number;
  estimatedRate: number;
}

const BANDIT_CONFIG = {
  gamma: 0.995,
  priorAlpha: 1.5,
  priorBeta: 1.0,
  minPulls: 3,
};

const ALL_MESSAGE_STRATEGIES: MessageStrategy[] = [
  'ai_contextual',
  'markov_chain',
  'natural_template',
  'question_doubt',
  'curiosity_gap',
  'legacy',
];

export const PROMOTION_MESSAGE_STRATEGIES: MessageStrategy[] = [
  'ai_contextual',
  'natural_template',
  'legacy',
];

function standardNormal(random: () => number): number {
  const u1 = Math.max(1e-10, safeUnitRandom(random));
  const u2 = safeUnitRandom(random);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function gammaSample(shape: number, random: () => number): number {
  if (!Number.isFinite(shape) || shape <= 0) return 1;
  if (shape < 1) {
    const sample = gammaSample(shape + 1, random);
    return sample * Math.pow(Math.max(1e-10, safeUnitRandom(random)), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  const MAX_ITERATIONS = 1000;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let x: number;
    let v: number;

    let innerAttempts = 0;
    do {
      x = standardNormal(random);
      v = Math.pow(1 + c * x, 3);
      innerAttempts++;
      if (innerAttempts > 100) { v = 1; break; }
    } while (v <= 0);

    if (Math.log(Math.max(1e-10, safeUnitRandom(random))) < 0.5 * x * x + d - d * v + d * Math.log(v)) {
      return d * v;
    }
  }

  return shape;
}

export function betaSample(a: number, b: number, random: () => number = Math.random): number {
  const alpha = safePositive(a, 1);
  const beta = safePositive(b, 1);
  const g1 = gammaSample(alpha, random);
  const g2 = gammaSample(beta, random);

  if (!Number.isFinite(g1 + g2) || g1 + g2 === 0) return 0.5;

  const raw = g1 / (g1 + g2);
  return Number.isFinite(raw) ? Math.min(0.999, Math.max(0.001, raw)) : 0.5;
}

interface SerializedArmState {
  strategy: MessageStrategy;
  successes: number;
  failures: number;
  totalPulls: number;
}

export class DiscountedThompsonSampling {
  private arms: ArmState[];
  private gamma: number;
  private priorAlpha: number;
  private priorBeta: number;
  private minPulls: number;

  constructor(strategies: MessageStrategy[], config?: Partial<typeof BANDIT_CONFIG>) {
    const merged = { ...BANDIT_CONFIG, ...(isRecord(config) ? config : {}) };
    this.gamma = clamp(merged.gamma, 0, 1, BANDIT_CONFIG.gamma);
    this.priorAlpha = safePositive(merged.priorAlpha, BANDIT_CONFIG.priorAlpha);
    this.priorBeta = safePositive(merged.priorBeta, BANDIT_CONFIG.priorBeta);
    this.minPulls = Math.floor(safeNonNegative(merged.minPulls));

    const safeStrategies = normalizeStrategies(strategies);
    this.arms = safeStrategies.map((strategy) => ({
      strategy,
      successes: 0,
      failures: 0,
      totalPulls: 0,
    }));
  }

  selectArm(): { strategy: MessageStrategy; sample: number } {
    const fallbackStrategy = this.fallbackStrategy();
    try {
      let bestStrategy = fallbackStrategy;
      let bestSample = -1;

      for (const arm of this.safeArms()) {
        const alpha = safeNonNegative(arm.successes) + this.priorAlpha;
        const beta = safeNonNegative(arm.failures) + this.priorBeta;
        const sample = betaSample(alpha, beta);

        if (sample > bestSample) {
          bestSample = sample;
          bestStrategy = arm.strategy;
        }
      }

      if (bestSample < 0) return { strategy: fallbackStrategy, sample: 0 };
      return { strategy: bestStrategy, sample: bestSample };
    } catch {
      return { strategy: fallbackStrategy, sample: 0 };
    }
  }

  update(strategy: MessageStrategy, reward: 0 | 1): void {
    const safeStrategy = normalizeMessageStrategy(strategy);
    if (!safeStrategy) return;
    const arm = this.safeArms().find((a) => a.strategy === safeStrategy);
    if (!arm) return;
    if (reward !== 0 && reward !== 1) return;

    const successes = safeNonNegative(arm.successes);
    const failures = safeNonNegative(arm.failures);
    const totalPulls = safeNonNegative(arm.totalPulls);

    // Apply discount before recording new outcome (recency weighting)
    if (totalPulls >= this.minPulls) {
      arm.successes = successes * this.gamma;
      arm.failures = failures * this.gamma;
    } else {
      arm.successes = successes;
      arm.failures = failures;
    }

    arm.totalPulls = totalPulls + 1;
    if (reward === 1) {
      arm.successes += 1;
    } else {
      arm.failures += 1;
    }
  }

  getStats(): Record<MessageStrategy, StrategyStats> {
    const stats = Object.fromEntries(
      ALL_MESSAGE_STRATEGIES
        .map((strategy) => [strategy, {
          successes: 0,
          failures: 0,
          totalPulls: 0,
          estimatedRate: 0.5,
        }]),
    ) as Record<MessageStrategy, StrategyStats>;

    for (const arm of this.safeArms()) {
      const successes = safeNonNegative(arm.successes);
      const failures = safeNonNegative(arm.failures);
      const total = successes + failures;
      stats[arm.strategy] = {
        successes,
        failures,
        totalPulls: safeNonNegative(arm.totalPulls),
        estimatedRate: total > 0 ? successes / total : 0.5,
      };
    }

    return stats;
  }

  reset(): void {
    for (const arm of this.safeArms()) {
      arm.successes = 0;
      arm.failures = 0;
      arm.totalPulls = 0;
    }
  }

  serialize(): SerializedArmState[] {
    return this.safeArms().map((arm) => ({
      strategy: arm.strategy,
      successes: Math.round(safeNonNegative(arm.successes) * 1000) / 1000,
      failures: Math.round(safeNonNegative(arm.failures) * 1000) / 1000,
      totalPulls: safeNonNegative(arm.totalPulls),
    }));
  }

  deserialize(data: SerializedArmState[]): void {
    if (!Array.isArray(data)) return;
    for (const saved of data) {
      const savedState = normalizeSerializedArmState(saved);
      if (!savedState) continue;
      const arm = this.safeArms().find((a) => a.strategy === savedState.strategy);
      if (arm) {
        arm.successes = safeNonNegative(savedState.successes);
        arm.failures = safeNonNegative(savedState.failures);
        arm.totalPulls = safeNonNegative(savedState.totalPulls);
      }
      // New strategies not in saved data keep their fresh state (0/0/0) — auto-explored
    }
  }

  private safeArms(): ArmState[] {
    if (!Array.isArray(this.arms)) return [];
    return this.arms.filter(isArmState);
  }

  private fallbackStrategy(): MessageStrategy {
    const first = Array.isArray(this.arms)
      ? this.arms[0]
      : isRecord(this.arms) ? this.arms['0'] : undefined;
    return isArmState(first) ? first.strategy : 'legacy';
  }
}

/**
 * Select strategy using per-channel arms when graduated (>= COLD_START_THRESHOLD pulls),
 * otherwise fall back to the global bandit.
 */
export function selectChannelStrategy(
  doc: ChannelIntelligenceDocument | null,
  globalBandit: DiscountedThompsonSampling,
): MessageStrategy {
  if (!doc) return globalBandit.selectArm().strategy;

  const strategyEntries = getStrategyEntries(doc.strategies)
    .filter(([strategy]) => (PROMOTION_MESSAGE_STRATEGIES as string[]).includes(strategy));
  const totalPulls = strategyEntries.reduce((sum, [, arm]) => sum + safeNonNegative(arm.n), 0);

  if (strategyEntries.length === 0 || totalPulls < COLD_START_THRESHOLD) {
    return globalBandit.selectArm().strategy;
  }

  let bestStrategy: MessageStrategy = 'ai_contextual';
  let bestSample = -1;

  for (const [strategy, arm] of strategyEntries) {
    const alpha = safeNonNegative(arm.s) + 1.5;
    const beta = safeNonNegative(arm.f) + 1.0;
    const sample = betaSample(alpha, beta);
    if (sample > bestSample) {
      bestSample = sample;
      bestStrategy = strategy;
    }
  }

  return bestStrategy;
}

function safeUnitRandom(random: () => number): number {
  try {
    const value = random();
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(0.999999999, value));
  } catch {
    return 0.5;
  }
}

function safePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeStrategies(value: unknown): MessageStrategy[] {
  if (!Array.isArray(value)) return ['legacy'];
  const seen = new Set<MessageStrategy>();
  for (const item of value) {
    const strategy = normalizeMessageStrategy(item);
    if (strategy && !seen.has(strategy)) seen.add(strategy);
  }
  return seen.size > 0 ? [...seen] : ['legacy'];
}

function isMessageStrategy(value: unknown): value is MessageStrategy {
  return typeof value === 'string' && (ALL_MESSAGE_STRATEGIES as string[]).includes(value);
}

function normalizeMessageStrategy(value: unknown): MessageStrategy | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (ALL_MESSAGE_STRATEGIES as string[]).includes(normalized)
    ? normalized as MessageStrategy
    : null;
}

function isArmState(value: unknown): value is ArmState {
  return isRecord(value) && isMessageStrategy(value['strategy']);
}

function normalizeSerializedArmState(value: unknown): SerializedArmState | null {
  if (!isRecord(value)) return null;
  const strategy = normalizeMessageStrategy(value['strategy']);
  if (!strategy) return null;
  return {
    strategy,
    successes: safeNonNegative(value['successes']),
    failures: safeNonNegative(value['failures']),
    totalPulls: safeNonNegative(value['totalPulls']),
  };
}

function getStrategyEntries(value: unknown): [MessageStrategy, StrategyArm][] {
  if (!isRecord(value)) return [];
  const entries: [MessageStrategy, StrategyArm][] = [];
  const seen = new Set<MessageStrategy>();
  for (const [rawStrategy, arm] of Object.entries(value)) {
    const strategy = normalizeMessageStrategy(rawStrategy);
    if (!strategy || seen.has(strategy) || !isRecord(arm)) continue;
    entries.push([strategy, arm as unknown as StrategyArm]);
    seen.add(strategy);
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

const BANDIT_CONFIG = {
  gamma: 0.995,
  priorAlpha: 1.5,
  priorBeta: 1.0,
  minPulls: 3,
};

function standardNormal(): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function gammaSample(shape: number): number {
  if (shape < 1) {
    const sample = gammaSample(shape + 1);
    return sample * Math.pow(Math.max(1e-10, Math.random()), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  const MAX_ITERATIONS = 1000;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let x: number;
    let v: number;

    let innerAttempts = 0;
    do {
      x = standardNormal();
      v = Math.pow(1 + c * x, 3);
      innerAttempts++;
      if (innerAttempts > 100) { v = 1; break; }
    } while (v <= 0);

    if (Math.log(Math.max(1e-10, Math.random())) < 0.5 * x * x + d - d * v + d * Math.log(v)) {
      return d * v;
    }
  }

  return shape;
}

export function betaSample(a: number, b: number): number {
  const g1 = gammaSample(a);
  const g2 = gammaSample(b);

  if (g1 + g2 === 0) return 0.5;

  const raw = g1 / (g1 + g2);
  return Math.min(0.999, Math.max(0.001, raw));
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
    const merged = { ...BANDIT_CONFIG, ...config };
    this.gamma = merged.gamma;
    this.priorAlpha = merged.priorAlpha;
    this.priorBeta = merged.priorBeta;
    this.minPulls = merged.minPulls;

    this.arms = strategies.map((strategy) => ({
      strategy,
      successes: 0,
      failures: 0,
      totalPulls: 0,
    }));
  }

  selectArm(): { strategy: MessageStrategy; sample: number } {
    try {
      let bestStrategy = this.arms[0].strategy;
      let bestSample = -1;

      for (const arm of this.arms) {
        const alpha = arm.successes + this.priorAlpha;
        const beta = arm.failures + this.priorBeta;
        const sample = betaSample(alpha, beta);

        if (sample > bestSample) {
          bestSample = sample;
          bestStrategy = arm.strategy;
        }
      }

      return { strategy: bestStrategy, sample: bestSample };
    } catch {
      return { strategy: this.arms[0].strategy, sample: 0 };
    }
  }

  update(strategy: MessageStrategy, reward: 0 | 1): void {
    const arm = this.arms.find((a) => a.strategy === strategy);
    if (!arm) return;

    // Apply discount before recording new outcome (recency weighting)
    if (arm.totalPulls >= this.minPulls) {
      arm.successes *= this.gamma;
      arm.failures *= this.gamma;
    }

    arm.totalPulls++;
    if (reward === 1) {
      arm.successes += 1;
    } else {
      arm.failures += 1;
    }
  }

  getStats(): Record<string, { successes: number; failures: number; totalPulls: number; estimatedRate: number }> {
    const stats: Record<string, { successes: number; failures: number; totalPulls: number; estimatedRate: number }> = {};

    for (const arm of this.arms) {
      const total = arm.successes + arm.failures;
      stats[arm.strategy] = {
        successes: arm.successes,
        failures: arm.failures,
        totalPulls: arm.totalPulls,
        estimatedRate: total > 0 ? arm.successes / total : 0.5,
      };
    }

    return stats;
  }

  reset(): void {
    for (const arm of this.arms) {
      arm.successes = 0;
      arm.failures = 0;
      arm.totalPulls = 0;
    }
  }

  serialize(): SerializedArmState[] {
    return this.arms.map((arm) => ({
      strategy: arm.strategy,
      successes: Math.round(arm.successes * 1000) / 1000,
      failures: Math.round(arm.failures * 1000) / 1000,
      totalPulls: arm.totalPulls,
    }));
  }

  deserialize(data: SerializedArmState[]): void {
    for (const saved of data) {
      const arm = this.arms.find((a) => a.strategy === saved.strategy);
      if (arm) {
        arm.successes = saved.successes;
        arm.failures = saved.failures;
        arm.totalPulls = saved.totalPulls;
      }
      // New strategies not in saved data keep their fresh state (0/0/0) — auto-explored
    }
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

  const totalPulls = Object.values(doc.strategies).reduce((sum, arm: StrategyArm) => sum + arm.n, 0);

  if (totalPulls < COLD_START_THRESHOLD) {
    return globalBandit.selectArm().strategy;
  }

  let bestStrategy: MessageStrategy = 'ai_contextual';
  let bestSample = -1;

  for (const [strategy, arm] of Object.entries(doc.strategies) as [MessageStrategy, StrategyArm][]) {
    const alpha = arm.s + 1.5;
    const beta = arm.f + 1.0;
    const sample = betaSample(alpha, beta);
    if (sample > bestSample) {
      bestSample = sample;
      bestStrategy = strategy;
    }
  }

  return bestStrategy;
}

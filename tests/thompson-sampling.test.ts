import {
  DiscountedThompsonSampling,
  betaSample,
  selectChannelStrategy,
  COLD_START_THRESHOLD,
} from '../src/message-strategy/message-strategy-selector';
import type { MessageStrategy, ChannelIntelligenceDocument } from '../src/channel-intelligence/channel-intelligence.types';
import { createDefaultIntelligence } from '../src/channel-intelligence/channel-intelligence.types';

const ALL_STRATEGIES: MessageStrategy[] = [
  'ai_contextual', 'markov_chain', 'natural_template',
  'question_doubt', 'curiosity_gap', 'legacy',
];

describe('betaSample', () => {
  it('returns values between 0.001 and 0.999', () => {
    for (let i = 0; i < 1000; i++) {
      const v = betaSample(1, 1);
      expect(v).toBeGreaterThanOrEqual(0.001);
      expect(v).toBeLessThanOrEqual(0.999);
    }
  });

  it('high alpha biases toward 1', () => {
    let sum = 0;
    const N = 500;
    for (let i = 0; i < N; i++) sum += betaSample(50, 1);
    expect(sum / N).toBeGreaterThan(0.9);
  });

  it('high beta biases toward 0', () => {
    let sum = 0;
    const N = 500;
    for (let i = 0; i < N; i++) sum += betaSample(1, 50);
    expect(sum / N).toBeLessThan(0.1);
  });

  it('equal alpha/beta centers around 0.5', () => {
    let sum = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) sum += betaSample(10, 10);
    expect(sum / N).toBeGreaterThan(0.4);
    expect(sum / N).toBeLessThan(0.6);
  });

  it('handles shape < 1', () => {
    const v = betaSample(0.5, 0.5);
    expect(v).toBeGreaterThanOrEqual(0.001);
    expect(v).toBeLessThanOrEqual(0.999);
  });
});

describe('DiscountedThompsonSampling', () => {
  let bandit: DiscountedThompsonSampling;

  beforeEach(() => {
    bandit = new DiscountedThompsonSampling(ALL_STRATEGIES);
  });

  describe('selectArm', () => {
    it('returns a valid strategy', () => {
      const { strategy, sample } = bandit.selectArm();
      expect(ALL_STRATEGIES).toContain(strategy);
      expect(sample).toBeGreaterThan(0);
    });

    it('explores all arms with no data', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        seen.add(bandit.selectArm().strategy);
      }
      // With uniform priors, should see most strategies
      expect(seen.size).toBeGreaterThanOrEqual(4);
    });

    it('does NOT discount during selection', () => {
      bandit.update('ai_contextual', 1);
      bandit.update('ai_contextual', 1);
      bandit.update('ai_contextual', 1);
      bandit.update('ai_contextual', 1);

      const statsBefore = bandit.getStats();
      const sBeforeSelect = statsBefore['ai_contextual'].successes;

      bandit.selectArm();

      const statsAfter = bandit.getStats();
      // Successes should NOT change from selection
      expect(statsAfter['ai_contextual'].successes).toBe(sBeforeSelect);
    });
  });

  describe('update', () => {
    it('increments success on reward=1', () => {
      bandit.update('legacy', 1);
      const stats = bandit.getStats();
      expect(stats['legacy'].successes).toBe(1);
      expect(stats['legacy'].totalPulls).toBe(1);
    });

    it('increments failure on reward=0', () => {
      bandit.update('legacy', 0);
      const stats = bandit.getStats();
      expect(stats['legacy'].failures).toBe(1);
    });

    it('applies discount after minPulls (3)', () => {
      bandit.update('ai_contextual', 1); // pull 1
      bandit.update('ai_contextual', 1); // pull 2
      bandit.update('ai_contextual', 1); // pull 3

      const stats = bandit.getStats();
      // After 3 pulls: discount applied before 3rd update
      // s was 2 -> 2*0.995 = 1.99 -> +1 = 2.99
      expect(stats['ai_contextual'].successes).toBeCloseTo(2.99, 1);
      expect(stats['ai_contextual'].totalPulls).toBe(3);
    });

    it('does NOT discount before minPulls', () => {
      bandit.update('legacy', 1);
      bandit.update('legacy', 1);
      const stats = bandit.getStats();
      // No discount: should be exactly 2
      expect(stats['legacy'].successes).toBe(2);
    });

    it('ignores unknown strategy', () => {
      bandit.update('nonexistent' as MessageStrategy, 1);
      // No crash, nothing changed
      const stats = bandit.getStats();
      for (const s of ALL_STRATEGIES) {
        expect(stats[s].totalPulls).toBe(0);
      }
    });
  });

  describe('convergence', () => {
    it('converges to best arm after many trials', () => {
      const bandit = new DiscountedThompsonSampling(ALL_STRATEGIES);

      // Simulate: ai_contextual has 80% success, others 30%
      for (let i = 0; i < 200; i++) {
        const { strategy } = bandit.selectArm();
        if (strategy === 'ai_contextual') {
          bandit.update(strategy, Math.random() < 0.8 ? 1 : 0);
        } else {
          bandit.update(strategy, Math.random() < 0.3 ? 1 : 0);
        }
      }

      // After 200 trials, ai_contextual should be selected most often
      let aiCount = 0;
      for (let i = 0; i < 100; i++) {
        if (bandit.selectArm().strategy === 'ai_contextual') aiCount++;
      }
      expect(aiCount).toBeGreaterThan(30); // Should win majority
    });
  });

  describe('getStats', () => {
    it('returns all strategies', () => {
      const stats = bandit.getStats();
      for (const s of ALL_STRATEGIES) {
        expect(stats[s]).toBeDefined();
        expect(stats[s].estimatedRate).toBe(0.5); // prior
      }
    });

    it('estimatedRate reflects performance', () => {
      for (let i = 0; i < 10; i++) bandit.update('ai_contextual', 1);
      for (let i = 0; i < 10; i++) bandit.update('legacy', 0);

      const stats = bandit.getStats();
      expect(stats['ai_contextual'].estimatedRate).toBeGreaterThan(0.9);
      expect(stats['legacy'].estimatedRate).toBeLessThan(0.1);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      bandit.update('ai_contextual', 1);
      bandit.update('legacy', 0);
      bandit.reset();

      const stats = bandit.getStats();
      for (const s of ALL_STRATEGIES) {
        expect(stats[s].totalPulls).toBe(0);
        expect(stats[s].successes).toBe(0);
        expect(stats[s].failures).toBe(0);
      }
    });
  });

  describe('serialize / deserialize', () => {
    it('roundtrips state', () => {
      for (let i = 0; i < 20; i++) {
        bandit.update('ai_contextual', 1);
        bandit.update('legacy', 0);
      }

      const serialized = bandit.serialize();
      const newBandit = new DiscountedThompsonSampling(ALL_STRATEGIES);
      newBandit.deserialize(serialized);

      const oldStats = bandit.getStats();
      const newStats = newBandit.getStats();

      expect(newStats['ai_contextual'].totalPulls).toBe(oldStats['ai_contextual'].totalPulls);
      expect(newStats['ai_contextual'].successes).toBeCloseTo(oldStats['ai_contextual'].successes, 2);
    });

    it('preserves new strategies not in saved data', () => {
      const saved = [{ strategy: 'ai_contextual' as const, successes: 5, failures: 2, totalPulls: 7 }];
      bandit.deserialize(saved);

      const stats = bandit.getStats();
      expect(stats['ai_contextual'].totalPulls).toBe(7);
      expect(stats['legacy'].totalPulls).toBe(0); // fresh
    });
  });
});

describe('selectChannelStrategy', () => {
  const globalBandit = new DiscountedThompsonSampling(ALL_STRATEGIES);

  it('uses global bandit when doc is null', () => {
    const strategy = selectChannelStrategy(null, globalBandit);
    expect(ALL_STRATEGIES).toContain(strategy);
  });

  it('uses global bandit below cold start threshold', () => {
    const doc = createDefaultIntelligence('ch1') as ChannelIntelligenceDocument;
    // totalPulls = 0 < COLD_START_THRESHOLD
    const strategy = selectChannelStrategy(doc, globalBandit);
    expect(ALL_STRATEGIES).toContain(strategy);
  });

  it('uses per-channel arms above cold start threshold', () => {
    const doc = createDefaultIntelligence('ch1') as ChannelIntelligenceDocument;
    // Set high pulls on ai_contextual with high success
    doc.strategies.ai_contextual = { s: 50, f: 5, n: COLD_START_THRESHOLD + 1 };

    const strategyCounts: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      const s = selectChannelStrategy(doc, globalBandit);
      strategyCounts[s] = (strategyCounts[s] || 0) + 1;
    }

    // ai_contextual should win most — it has 50 success vs 5 failure
    expect(strategyCounts['ai_contextual'] || 0).toBeGreaterThan(20);
  });
});

describe('edge cases', () => {
  it('selectArm catch returns fallback on corrupted arms', () => {
    const bandit = new DiscountedThompsonSampling(ALL_STRATEGIES);
    // Save reference to first strategy
    const firstStrategy = (bandit as any).arms[0].strategy;
    // Set arms to non-iterable to force error in for..of loop
    const realArms = (bandit as any).arms;
    (bandit as any).arms = { [Symbol.iterator]: () => { throw new Error('boom'); }, 0: realArms[0] };
    const result = bandit.selectArm();
    expect(result.strategy).toBe(firstStrategy);
    expect(result.sample).toBe(0);
    // Restore
    (bandit as any).arms = realArms;
  });

  it('betaSample with extreme tiny parameters', () => {
    // With shape < 1, uses the alternative sampling path
    const v = betaSample(0.01, 0.01);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

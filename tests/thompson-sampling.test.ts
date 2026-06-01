import {
  DiscountedThompsonSampling,
  betaSample,
  selectChannelStrategy,
  COLD_START_THRESHOLD,
} from '../src';
import type { MessageStrategy, ChannelIntelligenceDocument } from '../src';
import { createDefaultIntelligence } from '../src';

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

  it('normalizes malformed beta parameters and random output', () => {
    expect(betaSample(Number.NaN, Number.POSITIVE_INFINITY, () => Number.NaN)).toBeGreaterThanOrEqual(0.001);
    expect(betaSample(-1, 0, () => { throw new Error('random failed'); })).toBeLessThanOrEqual(0.999);
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

    it('dedupes invalid constructor strategies and keeps a valid fallback arm', () => {
      const malformedBandit = new DiscountedThompsonSampling([
        'legacy',
        ' legacy ' as MessageStrategy,
        'legacy',
        '' as MessageStrategy,
        'bad' as MessageStrategy,
      ]);

      malformedBandit.update('legacy', 1);

      expect(malformedBandit.selectArm().strategy).toBe('legacy');
      expect(malformedBandit.serialize()).toEqual([{
        strategy: 'legacy',
        successes: 1,
        failures: 0,
        totalPulls: 1,
      }]);
    });

    it('ignores malformed constructor config from JavaScript callers', () => {
      const malformedBandit = new DiscountedThompsonSampling(['legacy'], null as any);

      malformedBandit.update('legacy', 1);

      expect(malformedBandit.getStats().legacy.totalPulls).toBe(1);
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

    it('ignores malformed reward values', () => {
      bandit.update('legacy', 2 as any);
      expect(bandit.getStats().legacy.totalPulls).toBe(0);
    });

    it('normalizes whitespace-padded direct strategy updates', () => {
      bandit.update(' legacy ' as MessageStrategy, 1);
      expect(bandit.getStats().legacy).toEqual({
        successes: 1,
        failures: 0,
        totalPulls: 1,
        estimatedRate: 1,
      });
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

    it('sanitizes malformed serialized bandit state', () => {
      bandit.deserialize([
        {
          strategy: ' legacy ' as MessageStrategy,
          successes: Number.NaN,
          failures: -5,
          totalPulls: Number.POSITIVE_INFINITY,
        },
      ]);

      expect(bandit.getStats().legacy).toEqual({
        successes: 0,
        failures: 0,
        totalPulls: 0,
        estimatedRate: 0.5,
      });
      expect(bandit.serialize().find(arm => arm.strategy === 'legacy')).toEqual({
        strategy: 'legacy',
        successes: 0,
        failures: 0,
        totalPulls: 0,
      });
    });

    it('ignores non-array serialized bandit state from JavaScript callers', () => {
      bandit.update('legacy', 1);
      const before = bandit.getStats().legacy;

      expect(() => bandit.deserialize(null as any)).not.toThrow();

      expect(bandit.getStats().legacy).toEqual(before);
    });

    it('ignores malformed serialized entries from JavaScript callers', () => {
      expect(() => bandit.deserialize([
        null,
        123,
        { strategy: 'bad_strategy', successes: 100, failures: 0, totalPulls: 100 },
        { strategy: 'legacy', successes: '10', failures: Number.NaN, totalPulls: -1 },
        { strategy: 'ai_contextual', successes: 2, failures: 1, totalPulls: 3 },
      ] as any)).not.toThrow();

      expect(bandit.getStats().legacy).toEqual({
        successes: 0,
        failures: 0,
        totalPulls: 0,
        estimatedRate: 0.5,
      });
      expect(bandit.getStats().ai_contextual).toEqual({
        successes: 2,
        failures: 1,
        totalPulls: 3,
        estimatedRate: 2 / 3,
      });
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

  it('ignores persisted strategy arms that the current promotion sender cannot materialize', () => {
    const doc = createDefaultIntelligence('ch-unsupported-strategy') as ChannelIntelligenceDocument;
    doc.strategies.markov_chain = { s: 100, f: 0, n: COLD_START_THRESHOLD + 1 };
    doc.strategies.natural_template = { s: 1, f: 0, n: COLD_START_THRESHOLD + 1 };

    const selected = Array.from({ length: 20 }, () => selectChannelStrategy(doc, globalBandit));

    expect(selected).not.toContain('markov_chain');
  });

  it('falls back to global bandit when per-channel pulls are malformed', () => {
    const doc = createDefaultIntelligence('ch-malformed') as ChannelIntelligenceDocument;
    doc.strategies.ai_contextual = { s: 100, f: 0, n: Number.NaN };
    const globalBandit = new DiscountedThompsonSampling(['legacy']);

    expect(selectChannelStrategy(doc, globalBandit)).toBe('legacy');
  });

  it('falls back to global bandit when stored strategy state is malformed', () => {
    const doc = createDefaultIntelligence('ch-bad-strategies') as ChannelIntelligenceDocument;
    (doc as unknown as { strategies: unknown }).strategies = {
      legacy: null,
      bad_strategy: { s: 100, f: 0, n: 100 },
    };
    const globalBandit = new DiscountedThompsonSampling(['legacy']);

    expect(selectChannelStrategy(doc, globalBandit)).toBe('legacy');
  });

  it('normalizes whitespace-padded persisted strategy keys before selection', () => {
    const doc = createDefaultIntelligence('ch-padded-strategy') as ChannelIntelligenceDocument;
    (doc as unknown as { strategies: unknown }).strategies = {
      ' ai_contextual ': { s: 50, f: 1, n: COLD_START_THRESHOLD + 1 },
    };

    const selected = Array.from({ length: 20 }, () => selectChannelStrategy(doc, globalBandit));

    expect(selected).toContain('ai_contextual');
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

  it('public bandit methods tolerate corrupted arm storage', () => {
    const bandit = new DiscountedThompsonSampling(ALL_STRATEGIES);
    (bandit as any).arms = { [Symbol.iterator]: () => { throw new Error('boom'); } };

    expect(() => bandit.update('legacy', 1)).not.toThrow();
    expect(() => bandit.getStats()).not.toThrow();
    expect(() => bandit.reset()).not.toThrow();
    expect(() => bandit.serialize()).not.toThrow();
    expect(() => bandit.deserialize([{ strategy: 'legacy', successes: 1, failures: 0, totalPulls: 1 }])).not.toThrow();
    expect(bandit.selectArm()).toEqual({ strategy: 'legacy', sample: 0 });
  });

  it('normalizes poisoned arm counters before updating outcomes', () => {
    const bandit = new DiscountedThompsonSampling(['legacy']);
    (bandit as any).arms = [{
      strategy: 'legacy',
      successes: 'bad',
      failures: Number.NaN,
      totalPulls: 'bad',
    }];

    bandit.update('legacy', 1);

    expect(bandit.getStats().legacy).toEqual({
      successes: 1,
      failures: 0,
      totalPulls: 1,
      estimatedRate: 1,
    });
  });

  it('betaSample with extreme tiny parameters', () => {
    // With shape < 1, uses the alternative sampling path
    const v = betaSample(0.01, 0.01);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

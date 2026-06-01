import { ChannelClassifier, createDefaultIntelligence, type ChannelIntelligenceDocument } from '../src';
import { computeExpectedValue } from '../src';
import type { ChannelPercentiles } from '../src';

function makeDoc(overrides: Partial<ChannelIntelligenceDocument> = {}): ChannelIntelligenceDocument {
  return { ...createDefaultIntelligence('test'), ...overrides } as ChannelIntelligenceDocument;
}

describe('ChannelClassifier', () => {
  describe('keyword-based classification', () => {
    it('classifies high-intent from title keywords', () => {
      const r = ChannelClassifier.classify('Adult Dating Group', null, null);
      expect(r.category).toBe('high_intent');
      expect(r.confidence).toBeGreaterThan(0);
    });

    it('classifies social_chat from title keywords', () => {
      const r = ChannelClassifier.classify('Friends Chat Room', null, null);
      expect(r.category).toBe('social_chat');
    });

    it('classifies off_topic from title keywords', () => {
      const r = ChannelClassifier.classify('Crypto Trading Signals Finance', null, null);
      expect(r.category).toBe('off_topic');
      expect(r.confidence).toBeGreaterThan(0);
    });

    it('returns unclassified for no keyword matches', () => {
      const r = ChannelClassifier.classify('Random XYZ Group', null, null);
      expect(r.category).toBe('unclassified');
      expect(r.confidence).toBe(0);
    });

    it('uses username as additional signal', () => {
      const r = ChannelClassifier.classify('My Group', 'adultchat', null);
      expect(r.category).toBe('high_intent');
    });

    it('handles null/empty title', () => {
      const r = ChannelClassifier.classify('', null, null);
      expect(r.category).toBe('unclassified');
    });

    it('handles malformed title and username values from JavaScript callers', () => {
      const r = ChannelClassifier.classify(123 as unknown as string, {} as unknown as string, null);
      expect(r.category).toBe('unclassified');
      expect(r.confidence).toBe(0);
    });

    it('single high-intent keyword with no off-topic = high_intent', () => {
      const r = ChannelClassifier.classify('dating chat', null, null);
      // dating = high_intent, chat = social_chat
      // highIntentHits=1, offTopicHits=0 → high_intent
      expect(r.category).toBe('high_intent');
    });
  });

  describe('performance-based override', () => {
    it('conversions > 0.5 overrides to high_intent', () => {
      const doc = makeDoc({
        stage: 'optimized',
        strategies: {
          ai_contextual: { s: 20, f: 5, n: 25 },
          markov_chain: { s: 0, f: 0, n: 0 },
          natural_template: { s: 0, f: 0, n: 0 },
          question_doubt: { s: 0, f: 0, n: 0 },
          curiosity_gap: { s: 0, f: 0, n: 0 },
          legacy: { s: 0, f: 0, n: 0 },
        },
        conversions: 2.0,
        expectedValue: 0.8,
      });

      // Title says "crypto" (off_topic) but performance says high_intent
      const r = ChannelClassifier.classify('Crypto Group', null, doc);
      expect(r.category).toBe('high_intent');
      expect(r.confidence).toBeGreaterThan(0.5);
    });

    it('paid conversions carry stronger performance intent than generic conversions', () => {
      const doc = makeDoc({
        stage: 'optimized',
        strategies: {
          ai_contextual: { s: 5, f: 5, n: 10 },
          markov_chain: { s: 0, f: 0, n: 0 },
          natural_template: { s: 0, f: 0, n: 0 },
          question_doubt: { s: 0, f: 0, n: 0 },
          curiosity_gap: { s: 0, f: 0, n: 0 },
          legacy: { s: 0, f: 0, n: 0 },
        },
        conversions: 0,
        paidConversions: 1,
        expectedValue: 0.5,
      });

      const r = ChannelClassifier.classify('Crypto Group', null, doc);

      expect(r.category).toBe('high_intent');
      expect(r.confidence).toBeGreaterThan(0.5);
    });

    it('high EV overrides to social_chat', () => {
      const doc = makeDoc({
        stage: 'optimized',
        strategies: {
          ai_contextual: { s: 15, f: 3, n: 18 },
          markov_chain: { s: 0, f: 0, n: 0 },
          natural_template: { s: 0, f: 0, n: 0 },
          question_doubt: { s: 0, f: 0, n: 0 },
          curiosity_gap: { s: 0, f: 0, n: 0 },
          legacy: { s: 0, f: 0, n: 0 },
        },
        conversions: 0,
        expectedValue: 0.8,
      });

      const r = ChannelClassifier.classify('Unknown Group', null, doc);
      expect(r.category).toBe('social_chat');
    });

    it('low EV classifies as off_topic', () => {
      const doc = makeDoc({
        stage: 'learning',
        strategies: {
          ai_contextual: { s: 1, f: 10, n: 11 },
          markov_chain: { s: 0, f: 0, n: 0 },
          natural_template: { s: 0, f: 0, n: 0 },
          question_doubt: { s: 0, f: 0, n: 0 },
          curiosity_gap: { s: 0, f: 0, n: 0 },
          legacy: { s: 0, f: 0, n: 0 },
        },
        conversions: 0,
        expectedValue: 0.1,
      });

      const r = ChannelClassifier.classify('Some Nice Chat', null, doc);
      expect(r.category).toBe('off_topic');
    });

    it('new stage channels use keywords only', () => {
      const doc = makeDoc({ stage: 'new' });
      const r = ChannelClassifier.classify('Adult Group', null, doc);
      expect(r.category).toBe('high_intent'); // from keywords
    });

    it('mid-range EV (0.3-0.7) with no conversions falls through to keywords', () => {
      const doc = makeDoc({
        stage: 'learning',
        strategies: {
          ai_contextual: { s: 5, f: 5, n: 10 },
          markov_chain: { s: 0, f: 0, n: 0 },
          natural_template: { s: 0, f: 0, n: 0 },
          question_doubt: { s: 0, f: 0, n: 0 },
          curiosity_gap: { s: 0, f: 0, n: 0 },
          legacy: { s: 0, f: 0, n: 0 },
        },
        conversions: 0,
        expectedValue: 0.5, // between 0.3 and 0.7 — no performance override
      });
      // performanceConfidence stays 0, so keywords apply: "chat" = social_chat
      const r = ChannelClassifier.classify('Nice Chat Room', null, doc);
      expect(r.category).toBe('social_chat');
    });

    it('low pulls (<10) use keywords only', () => {
      const doc = makeDoc({
        stage: 'learning',
        strategies: {
          ai_contextual: { s: 3, f: 0, n: 3 },
          markov_chain: { s: 0, f: 0, n: 0 },
          natural_template: { s: 0, f: 0, n: 0 },
          question_doubt: { s: 0, f: 0, n: 0 },
          curiosity_gap: { s: 0, f: 0, n: 0 },
          legacy: { s: 0, f: 0, n: 0 },
        },
        expectedValue: 0.9,
      });

      const r = ChannelClassifier.classify('Crypto News', null, doc);
      // totalPulls=3 < 10, so keywords apply: crypto+news = off_topic
      expect(r.category).toBe('off_topic');
    });

    it('treats malformed cached EV and counters as neutral performance data', () => {
      const doc = makeDoc({
        stage: 'optimized',
        strategies: {
          ai_contextual: { s: 10, f: 0, n: Number.NaN },
          markov_chain: { s: 0, f: 0, n: -20 },
          natural_template: { s: 0, f: 0, n: 0 },
          question_doubt: { s: 0, f: 0, n: 0 },
          curiosity_gap: { s: 0, f: 0, n: 0 },
          legacy: { s: 0, f: 0, n: 0 },
        },
        conversions: -5,
        expectedValue: 5,
      });

      const r = ChannelClassifier.classify('Crypto News Finance', null, doc);
      expect(r.category).toBe('off_topic');
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.promotionFitScore).toBeGreaterThanOrEqual(0);
      expect(r.promotionFitScore).toBeLessThanOrEqual(1);
    });

    it('falls back to keyword classification when stored strategy state is malformed', () => {
      const doc = makeDoc({
        stage: 'optimized',
        strategies: null as unknown as ChannelIntelligenceDocument['strategies'],
        conversions: 2,
        expectedValue: 0.9,
      });

      const r = ChannelClassifier.classify('Crypto News Finance', null, doc);

      expect(r.category).toBe('off_topic');
      expect(r.confidence).toBeGreaterThan(0);
    });
  });

  describe('promotionFitScore', () => {
    it('returns 0-1 range', () => {
      const r = ChannelClassifier.classify('Test', null, null);
      expect(r.promotionFitScore).toBeGreaterThanOrEqual(0);
      expect(r.promotionFitScore).toBeLessThanOrEqual(1);
    });

    it('high-intent keywords increase score', () => {
      const hi = ChannelClassifier.classify('Adult Dating Escort', null, null);
      const lo = ChannelClassifier.classify('Random Group', null, null);
      expect(hi.promotionFitScore).toBeGreaterThan(lo.promotionFitScore);
    });

    it('performance data dominates when confident', () => {
      const doc = makeDoc({
        stage: 'optimized',
        strategies: {
          ai_contextual: { s: 30, f: 2, n: 32 },
          markov_chain: { s: 0, f: 0, n: 0 },
          natural_template: { s: 0, f: 0, n: 0 },
          question_doubt: { s: 0, f: 0, n: 0 },
          curiosity_gap: { s: 0, f: 0, n: 0 },
          legacy: { s: 0, f: 0, n: 0 },
        },
        conversions: 3,
        expectedValue: 0.85,
      });
      const r = ChannelClassifier.classify('Generic Name', null, doc);
      // With high performance, promotionFitScore should be dominated by 0.85 * 0.8
      expect(r.promotionFitScore).toBeGreaterThan(0.6);
    });
  });
});

describe('computeExpectedValue', () => {
  it('returns 0.5 for default doc (no data)', () => {
    const doc = makeDoc();
    const ev = computeExpectedValue(doc);
    expect(ev).toBeCloseTo(0.5, 1);
  });

  it('increases with strategy success', () => {
    const doc = makeDoc({
      strategies: {
        ai_contextual: { s: 20, f: 2, n: 22 },
        markov_chain: { s: 0, f: 0, n: 0 },
        natural_template: { s: 0, f: 0, n: 0 },
        question_doubt: { s: 0, f: 0, n: 0 },
        curiosity_gap: { s: 0, f: 0, n: 0 },
        legacy: { s: 0, f: 0, n: 0 },
      },
    });
    const ev = computeExpectedValue(doc);
    expect(ev).toBeGreaterThan(0.8);
  });

  it('ignores historical strategy arms that the current sender cannot materialize', () => {
    const unsupportedOnly = makeDoc({
      strategies: {
        ai_contextual: { s: 0, f: 0, n: 0 },
        markov_chain: { s: 100, f: 0, n: 100 },
        natural_template: { s: 0, f: 0, n: 0 },
        question_doubt: { s: 100, f: 0, n: 100 },
        curiosity_gap: { s: 100, f: 0, n: 100 },
        legacy: { s: 0, f: 0, n: 0 },
      },
    });
    const supportedSuccess = makeDoc({
      strategies: {
        ai_contextual: { s: 20, f: 0, n: 20 },
        markov_chain: { s: 0, f: 0, n: 0 },
        natural_template: { s: 0, f: 0, n: 0 },
        question_doubt: { s: 0, f: 0, n: 0 },
        curiosity_gap: { s: 0, f: 0, n: 0 },
        legacy: { s: 0, f: 0, n: 0 },
      },
    });

    expect(computeExpectedValue(unsupportedOnly)).toBeCloseTo(0.5, 3);
    expect(computeExpectedValue(supportedSuccess)).toBeGreaterThan(0.9);
  });

  it('applies followup bonus when enough data', () => {
    const withFu = makeDoc({
      followupTotal: 10,
      followupSuccessRate: 0.9,
    });
    const withoutFu = makeDoc({
      followupTotal: 10,
      followupSuccessRate: 0.5,
    });

    expect(computeExpectedValue(withFu)).toBeGreaterThan(computeExpectedValue(withoutFu));
  });

  it('no followup bonus below 5 total', () => {
    const doc1 = makeDoc({ followupTotal: 3, followupSuccessRate: 0.9 });
    const doc2 = makeDoc({ followupTotal: 3, followupSuccessRate: 0.1 });
    // Both should have same EV since followup data is ignored
    expect(computeExpectedValue(doc1)).toBeCloseTo(computeExpectedValue(doc2), 2);
  });

  it('applies automod penalty', () => {
    const clean = makeDoc();
    const automodded = makeDoc({
      deletionTiming: { automod: 10, bot: 0, human: 0, late: 0 },
    });
    expect(computeExpectedValue(automodded)).toBeLessThan(computeExpectedValue(clean));
  });

  it('applies error penalty', () => {
    const clean = makeDoc();
    const errored = makeDoc({
      errors: { consecutiveErrors: 5 },
    });
    expect(computeExpectedValue(errored)).toBeLessThan(computeExpectedValue(clean));
  });

  it('error penalty caps at 0.4', () => {
    const doc = makeDoc({
      errors: { consecutiveErrors: 100 },
    });
    const ev = computeExpectedValue(doc);
    // With capped penalty, EV should still be > 0.01
    expect(ev).toBeGreaterThanOrEqual(0.01);
  });

  it('applies online bonus when recent and high ewma', () => {
    const online = makeDoc({
      onlineTrend: { ewma: 200, lastSampled: Date.now() - 5 * 60000, sampleCount: 5 },
    });
    const offline = makeDoc({
      onlineTrend: { ewma: 200, lastSampled: Date.now() - 60 * 60000, sampleCount: 5 },
    });
    expect(computeExpectedValue(online)).toBeGreaterThan(computeExpectedValue(offline));
  });

  it('applies view engagement bonus', () => {
    const engaged = makeDoc({
      viewEngagement: { ewmaRatio: 0.8, lastChecked: Date.now() - 10 * 60000, checksCount: 5 },
    });
    const stale = makeDoc({
      viewEngagement: { ewmaRatio: 0.8, lastChecked: Date.now() - 120 * 60000, checksCount: 5 },
    });
    expect(computeExpectedValue(engaged)).toBeGreaterThan(computeExpectedValue(stale));
  });

  it('does not turn low recent view engagement into an implicit penalty', () => {
    const lowViews = makeDoc({
      viewEngagement: { ewmaRatio: 0.1, lastChecked: Date.now() - 10 * 60000, checksCount: 5 },
    });
    const noViews = makeDoc();

    expect(computeExpectedValue(lowViews)).toBeCloseTo(computeExpectedValue(noViews), 3);
  });

  it('applies category bonus for high_intent', () => {
    const hi = makeDoc({ channelCategory: 'high_intent' });
    const unclassified = makeDoc({ channelCategory: 'unclassified' });
    expect(computeExpectedValue(hi)).toBeGreaterThan(computeExpectedValue(unclassified));
  });

  it('applies category penalty for off_topic', () => {
    const off = makeDoc({ channelCategory: 'off_topic' });
    const unclassified = makeDoc({ channelCategory: 'unclassified' });
    expect(computeExpectedValue(off)).toBeLessThan(computeExpectedValue(unclassified));
  });

  it('clamps between 0.01 and 0.99', () => {
    // Force extremely high
    const maxDoc = makeDoc({
      strategies: {
        ai_contextual: { s: 100, f: 0, n: 100 },
        markov_chain: { s: 0, f: 0, n: 0 },
        natural_template: { s: 0, f: 0, n: 0 },
        question_doubt: { s: 0, f: 0, n: 0 },
        curiosity_gap: { s: 0, f: 0, n: 0 },
        legacy: { s: 0, f: 0, n: 0 },
      },
      channelCategory: 'high_intent',
      followupTotal: 20,
      followupSuccessRate: 1.0,
      onlineTrend: { ewma: 500, lastSampled: Date.now(), sampleCount: 10 },
    });
    expect(computeExpectedValue(maxDoc)).toBeLessThanOrEqual(0.99);

    // Force extremely low
    const minDoc = makeDoc({
      errors: { consecutiveErrors: 50 },
      channelCategory: 'off_topic',
      deletionTiming: { automod: 100, bot: 0, human: 0, late: 0 },
    });
    expect(computeExpectedValue(minDoc)).toBeGreaterThanOrEqual(0.01);
  });

  it('keeps malformed metric values bounded without accidental boosts or penalties', () => {
    const malformed = makeDoc({
      strategies: {
        ai_contextual: { s: Number.NaN, f: Number.POSITIVE_INFINITY, n: 10 },
        markov_chain: { s: -10, f: -5, n: 10 },
        natural_template: { s: 0, f: 0, n: 0 },
        question_doubt: { s: 0, f: 0, n: 0 },
        curiosity_gap: { s: 0, f: 0, n: 0 },
        legacy: { s: 0, f: 0, n: 0 },
      },
      followupTotal: Number.NaN,
      followupSuccessRate: 99,
      deletionTiming: { automod: Number.NaN, bot: -1, human: 0, late: 0 },
      onlineTrend: { ewma: Number.POSITIVE_INFINITY, lastSampled: Date.now(), sampleCount: 5 },
      viewEngagement: { ewmaRatio: Number.NaN, lastChecked: Date.now(), checksCount: Number.NaN },
      errors: { consecutiveErrors: -10 },
      conversions: Number.NaN,
      totalSendsToChannel: Number.NaN,
      saturationRate: Number.NaN,
    } as Partial<ChannelIntelligenceDocument>);

    expect(computeExpectedValue(malformed)).toBeCloseTo(0.5, 3);
  });

  it('does not award freshness bonuses for future-dated online or view timestamps', () => {
    const future = Date.now() + 60 * 60_000;
    const futureSignals = makeDoc({
      onlineTrend: { ewma: 500, lastSampled: future, sampleCount: 5 },
      viewEngagement: { ewmaRatio: 0.95, lastChecked: future, checksCount: 5 },
    });
    const noSignals = makeDoc();

    expect(computeExpectedValue(futureSignals)).toBeCloseTo(computeExpectedValue(noSignals), 3);
  });

  it('handles missing nested scoring state from untyped callers', () => {
    const malformed = {
      channelId: 'missing-nested',
      channelCategory: 123,
      strategies: null,
      deletionTiming: null,
      onlineTrend: null,
      viewEngagement: null,
      errors: null,
    } as unknown as ChannelIntelligenceDocument;

    expect(computeExpectedValue(malformed)).toBeCloseTo(0.5, 3);
  });

  it('handles malformed top-level scoring documents from untyped callers', () => {
    expect(computeExpectedValue(null as unknown as ChannelIntelligenceDocument)).toBeCloseTo(0.5, 3);
    expect(computeExpectedValue([] as unknown as ChannelIntelligenceDocument)).toBeCloseTo(0.5, 3);
  });

  describe('with percentiles', () => {
    const mockPercentiles: ChannelPercentiles = {
      successRate: { p10: 0.1, p25: 0.3, p50: 0.5, p75: 0.7, p90: 0.9, count: 100 },
      deleteRate: { p10: 0, p25: 0.05, p50: 0.1, p75: 0.2, p90: 0.4, count: 100 },
      participantsCount: { p10: 200, p25: 500, p50: 1000, p75: 3000, p90: 10000, count: 100 },
      deletedCount: { p10: 0, p25: 1, p50: 5, p75: 15, p90: 40, count: 100 },
      messageVolume: { p10: 5, p25: 15, p50: 50, p75: 150, p90: 400, count: 100 },
      followupSurvivalRate: { p10: 0.1, p25: 0.3, p50: 0.5, p75: 0.7, p90: 0.9, count: 100 },
      conversionRate: { p10: 0, p25: 0, p50: 0, p75: 0.01, p90: 0.05, count: 100 },
      saturationRate: { p10: 0.05, p25: 0.1, p50: 0.3, p75: 0.8, p90: 2.0, count: 100 },
    };

    const mockGetRank = (value: number, metric: keyof ChannelPercentiles): number => {
      const p = mockPercentiles[metric];
      if (value <= p.p10) return 0.1;
      if (value <= p.p25) return 0.25;
      if (value <= p.p50) return 0.5;
      if (value <= p.p75) return 0.75;
      if (value <= p.p90) return 0.9;
      return 0.95;
    };

    it('applies conversion bonus above p75', () => {
      const doc = makeDoc({ conversions: 0.05 }); // above p90 for conversionRate
      const withP = computeExpectedValue(doc, mockPercentiles, mockGetRank);
      const withoutP = computeExpectedValue(doc);
      expect(withP).toBeGreaterThan(withoutP);
    });

    it('uses conversions per send rather than raw conversion count', () => {
      const ranks: Array<{ value: number; metric: keyof ChannelPercentiles }> = [];
      const captureRank = (value: number, metric: keyof ChannelPercentiles): number => {
        ranks.push({ value, metric });
        return mockGetRank(value, metric);
      };

      computeExpectedValue(
        makeDoc({ conversions: 5, totalSendsToChannel: 500 }),
        mockPercentiles,
        captureRank,
      );

      const conversionRankInput = ranks.find(r => r.metric === 'conversionRate');
      expect(conversionRankInput?.value).toBeCloseTo(0.01, 5);
    });

    it('counts paid conversions as stronger conversion-rate evidence', () => {
      const ranks: Array<{ value: number; metric: keyof ChannelPercentiles }> = [];
      const captureRank = (value: number, metric: keyof ChannelPercentiles): number => {
        ranks.push({ value, metric });
        return mockGetRank(value, metric);
      };

      computeExpectedValue(
        makeDoc({ conversions: 1, paidConversions: 2, totalSendsToChannel: 100 }),
        mockPercentiles,
        captureRank,
      );

      const conversionRankInput = ranks.find(r => r.metric === 'conversionRate');
      expect(conversionRankInput?.value).toBeCloseTo(0.05, 5);
    });

    it('applies saturation penalty above p75', () => {
      const doc = makeDoc({ saturationRate: 1.5 }); // above p75
      const withP = computeExpectedValue(doc, mockPercentiles, mockGetRank);
      const withoutP = computeExpectedValue(doc);
      expect(withP).toBeLessThan(withoutP);
    });

    it('applies saturation penalty at p90+ (heavier than p75)', () => {
      // Use custom getRank to precisely control the rank values
      const getRankP90 = (value: number, metric: keyof ChannelPercentiles): number => {
        if (metric === 'saturationRate') return 0.92; // above p90
        return mockGetRank(value, metric);
      };
      const getRankP80 = (value: number, metric: keyof ChannelPercentiles): number => {
        if (metric === 'saturationRate') return 0.80; // between p75-p90
        return mockGetRank(value, metric);
      };
      const doc = makeDoc({ saturationRate: 2.0 });
      const evP90 = computeExpectedValue(doc, mockPercentiles, getRankP90);
      const evP80 = computeExpectedValue(doc, mockPercentiles, getRankP80);
      expect(evP90).toBeLessThan(evP80); // p90+ penalty (0.25) > p75-p90 penalty (0.12)
    });

    it('applies moderate conversion bonus between p50-p75', () => {
      // conversionRate p50=0, p75=0.01 — value 0.005 should rank ~0.5-0.75
      const mockGetRankMid = (value: number, metric: keyof ChannelPercentiles): number => {
        if (metric === 'conversionRate') return 0.6; // between p50-p75
        return mockGetRank(value, metric);
      };
      const doc = makeDoc({ conversions: 0.005 });
      const withP = computeExpectedValue(doc, mockPercentiles, mockGetRankMid);
      const withoutP = computeExpectedValue(doc);
      // p50-p75 gets 0.08 bonus
      expect(withP).toBeGreaterThan(withoutP);
    });

    it('neutralizes throwing or malformed percentile rank callbacks', () => {
      const doc = makeDoc({ conversions: 5, totalSendsToChannel: 10, saturationRate: 99 });
      const throwingRank = () => { throw new Error('rank unavailable'); };
      const malformedRank = () => Number.NaN;

      expect(computeExpectedValue(doc, mockPercentiles, throwingRank)).toBeCloseTo(
        computeExpectedValue(doc, mockPercentiles, malformedRank),
        5,
      );
      expect(computeExpectedValue(doc, mockPercentiles, throwingRank)).toBeGreaterThanOrEqual(0.01);
      expect(computeExpectedValue(doc, mockPercentiles, throwingRank)).toBeLessThanOrEqual(0.99);
    });
  });

  it('applies social_chat category bonus', () => {
    const social = makeDoc({ channelCategory: 'social_chat' as any });
    const unclassified = makeDoc({ channelCategory: 'unclassified' });
    expect(computeExpectedValue(social)).toBeGreaterThan(computeExpectedValue(unclassified));
  });
});

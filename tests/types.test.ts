import {
  createDefaultStrategies,
  createDefaultIntelligence,
} from '../src';
import type { MessageStrategy } from '../src';

const ALL_STRATEGIES: MessageStrategy[] = [
  'ai_contextual', 'markov_chain', 'natural_template',
  'question_doubt', 'curiosity_gap', 'legacy',
];

describe('createDefaultStrategies', () => {
  it('returns all 6 strategies', () => {
    const strategies = createDefaultStrategies();
    for (const s of ALL_STRATEGIES) {
      expect(strategies[s]).toBeDefined();
    }
  });

  it('all arms start at zero', () => {
    const strategies = createDefaultStrategies();
    for (const s of ALL_STRATEGIES) {
      expect(strategies[s].s).toBe(0);
      expect(strategies[s].f).toBe(0);
      expect(strategies[s].n).toBe(0);
    }
  });

  it('returns independent copies', () => {
    const s1 = createDefaultStrategies();
    const s2 = createDefaultStrategies();
    s1.ai_contextual.s = 999;
    expect(s2.ai_contextual.s).toBe(0);
  });
});

describe('createDefaultIntelligence', () => {
  it('sets channelId', () => {
    const doc = createDefaultIntelligence('ch123');
    expect(doc.channelId).toBe('ch123');
  });

  it('starts in new stage', () => {
    const doc = createDefaultIntelligence('ch1');
    expect(doc.stage).toBe('new');
  });

  it('uses provided topic', () => {
    const doc = createDefaultIntelligence('ch1', 'dating');
    expect(doc.topic).toBe('dating');
  });

  it('defaults topic to general_chat', () => {
    const doc = createDefaultIntelligence('ch1');
    expect(doc.topic).toBe('general_chat');
  });

  it('initializes all required fields', () => {
    const doc = createDefaultIntelligence('ch1');
    expect(doc.strategies).toBeDefined();
    expect(doc.deletionTiming).toEqual({ automod: 0, bot: 0, human: 0, late: 0 });
    expect(doc.onlineTrend).toEqual({ ewma: 0, lastSampled: 0, sampleCount: 0 });
    expect(doc.viewEngagement).toEqual({ ewmaRatio: 0, lastChecked: 0, checksCount: 0 });
    expect(doc.errors).toEqual({ consecutiveErrors: 0 });
    expect(doc.conversions).toBe(0);
    expect(doc.paidConversions).toBe(0);
    expect(doc.totalSendsToChannel).toBe(0);
    expect(doc.saturationRate).toBe(0);
    expect(doc.channelCategory).toBe('unclassified');
    expect(doc.promotionFitScore).toBe(0.25);
  });

  it('sets timestamps', () => {
    const before = Date.now();
    const doc = createDefaultIntelligence('ch1');
    expect(doc.firstSeenAt).toBeGreaterThanOrEqual(before);
    expect(doc.stageUpdatedAt).toBeGreaterThanOrEqual(before);
    expect(doc.scoreUpdatedAt).toBeGreaterThanOrEqual(before);
  });
});

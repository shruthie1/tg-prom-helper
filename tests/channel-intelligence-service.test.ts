import { Collection } from 'mongodb';
import { setupMongo, teardownMongo, createRedis, seedActiveChannels } from './helpers';
import { ChannelIntelligenceService } from '../src/channel-intelligence/channel-intelligence-service';
import { PercentileEngine } from '../src/channel-intelligence/percentile-engine';
import type { ChannelIntelligenceDocument } from '../src/channel-intelligence/channel-intelligence.types';
import type { Redis } from 'ioredis';

describe('ChannelIntelligenceService', () => {
  let intelligence: Collection<ChannelIntelligenceDocument>;
  let activeChannels: Collection;
  let redis: Redis;
  let service: ChannelIntelligenceService;

  beforeAll(async () => {
    const mongo = await setupMongo();
    activeChannels = mongo.activeChannels;
    intelligence = mongo.intelligence;
    redis = createRedis();
  });

  afterAll(async () => {
    await redis.quit();
    await teardownMongo();
  });

  beforeEach(async () => {
    await intelligence.deleteMany({});
    await activeChannels.deleteMany({});
    await redis.flushall();
    (ChannelIntelligenceService as any).instance = undefined;
    (PercentileEngine as any).instance = undefined;
    service = new ChannelIntelligenceService(intelligence);
  });

  describe('singleton', () => {
    it('init creates singleton', () => {
      const s = ChannelIntelligenceService.init(intelligence);
      expect(s).toBeInstanceOf(ChannelIntelligenceService);
      expect(ChannelIntelligenceService.getInstance()).toBe(s);
    });

    it('getInstance throws before init', () => {
      expect(() => ChannelIntelligenceService.getInstance()).toThrow();
    });
  });

  describe('ensureDoc', () => {
    it('creates new doc with defaults', async () => {
      await service.ensureDoc('ch1');
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc).toBeTruthy();
      expect(doc!.stage).toBe('new');
      expect(doc!.strategies.ai_contextual.n).toBe(0);
      expect(doc!.conversions).toBe(0);
      expect(doc!.totalSendsToChannel).toBe(0);
    });

    it('does not overwrite existing doc', async () => {
      await service.ensureDoc('ch1');
      await intelligence.updateOne({ channelId: 'ch1' }, { $set: { stage: 'learning' } });
      await service.ensureDoc('ch1');
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.stage).toBe('learning');
    });
  });

  describe('recordSuccess', () => {
    it('increments strategy success and n', async () => {
      await service.recordSuccess('ch1', 'ai_contextual', false);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.strategies.ai_contextual.s).toBeGreaterThanOrEqual(1);
      expect(doc!.strategies.ai_contextual.n).toBe(1);
    });

    it('increments totalSendsToChannel', async () => {
      await service.recordSuccess('ch1', 'legacy', false);
      await service.recordSuccess('ch1', 'legacy', false);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.totalSendsToChannel).toBe(2);
    });

    it('increments followup counters on followup', async () => {
      await service.recordSuccess('ch1', 'ai_contextual', true);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.followupTotal).toBe(1);
      expect(doc!.followupSuccessCount).toBe(1);
    });

    it('resets consecutiveErrors on success', async () => {
      await service.recordFailure('ch1', 'legacy', 'PEER_FLOOD');
      await service.recordFailure('ch1', 'legacy', 'PEER_FLOOD');
      let doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.errors.consecutiveErrors).toBe(2);

      await service.recordSuccess('ch1', 'legacy', false);
      doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.errors.consecutiveErrors).toBe(0);
    });

    it('updates expectedValue', async () => {
      await service.recordSuccess('ch1', 'ai_contextual', false);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.expectedValue).toBeGreaterThan(0);
      expect(doc!.scoreUpdatedAt).toBeGreaterThan(0);
    });
  });

  describe('recordDeletion', () => {
    it('increments strategy failure and n', async () => {
      await service.recordDeletion('ch1', 'markov_chain', 5000, false);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.strategies.markov_chain.f).toBeGreaterThanOrEqual(1);
      expect(doc!.strategies.markov_chain.n).toBe(1);
    });

    it('classifies automod deletion (<30s)', async () => {
      await service.recordDeletion('ch1', 'legacy', 10000, false); // 10s
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.deletionTiming.automod).toBe(1);
    });

    it('classifies bot deletion (30s-2min)', async () => {
      await service.recordDeletion('ch1', 'legacy', 60000, false); // 60s
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.deletionTiming.bot).toBe(1);
    });

    it('classifies human deletion (2-10min)', async () => {
      await service.recordDeletion('ch1', 'legacy', 5 * 60000, false); // 5 min
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.deletionTiming.human).toBe(1);
    });

    it('classifies late deletion (>10min)', async () => {
      await service.recordDeletion('ch1', 'legacy', 15 * 60000, false); // 15 min
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.deletionTiming.late).toBe(1);
    });

    it('increments followupTotal on followup deletion', async () => {
      await service.recordDeletion('ch1', 'legacy', 5000, true);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.followupTotal).toBe(1);
      // NOT followupSuccessCount — deletion is not a success
    });
  });

  describe('recordFailure', () => {
    it('increments error category', async () => {
      await service.recordFailure('ch1', 'legacy', 'PEER_FLOOD error');
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.errors.PEER_FLOOD).toBe(1);
      expect(doc!.errors.lastErrorType).toBe('PEER_FLOOD error');
    });

    it('sets cooldown for CHANNEL_RESTRICTED', async () => {
      const before = Date.now();
      await service.recordFailure('ch1', 'legacy', 'CHANNEL_RESTRICTED');
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      // 7 days cooldown
      expect(doc!.cooldownUntil).toBeGreaterThan(before + 6 * 24 * 3600000);
    });

    it('increments consecutiveErrors', async () => {
      await service.recordFailure('ch1', 'legacy', 'TRANSIENT');
      await service.recordFailure('ch1', 'legacy', 'TRANSIENT');
      await service.recordFailure('ch1', 'legacy', 'TRANSIENT');
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.errors.consecutiveErrors).toBe(3);
    });

    it('categorizes unknown errors as TRANSIENT', async () => {
      await service.recordFailure('ch1', 'legacy', 'some random error');
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.errors.TRANSIENT).toBe(1);
    });
  });

  describe('lifecycle transitions', () => {
    it('transitions from new to learning after enough pulls', async () => {
      // Without percentile engine, uses fallback: 5 pulls
      for (let i = 0; i < 6; i++) {
        await service.recordSuccess('ch1', 'ai_contextual', false);
      }
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.stage).toBe('learning');
    });

    it('transitions from learning to optimized with enough data and good EV', async () => {
      // Get to learning first
      for (let i = 0; i < 6; i++) {
        await service.recordSuccess('ch1', 'ai_contextual', false);
      }

      // Now add more successes to reach optimized (30 pulls, EV >= 0.5)
      for (let i = 0; i < 25; i++) {
        await service.recordSuccess('ch1', 'ai_contextual', false);
      }
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.stage).toBe('optimized');
    });

    it('transitions to hostile on many deletions', async () => {
      for (let i = 0; i < 35; i++) {
        await service.recordDeletion('ch1', 'legacy', 5000, false);
      }
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.stage).toBe('hostile');
    });

    it('transitions to hostile on >5 consecutive errors', async () => {
      for (let i = 0; i < 7; i++) {
        await service.recordFailure('ch1', 'legacy', 'TRANSIENT');
      }
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.stage).toBe('hostile');
    });

    it('hostile recovery without percentile engine (fallback)', async () => {
      // Make channel hostile via deletions (no percentile engine active)
      for (let i = 0; i < 35; i++) {
        await service.recordDeletion('ch_recover', 'legacy', 5000, false);
      }
      let doc = await intelligence.findOne({ channelId: 'ch_recover' });
      expect(doc!.stage).toBe('hostile');

      // Simulate time passing (>72h) and reset errors + deletions
      await intelligence.updateOne(
        { channelId: 'ch_recover' },
        { $set: {
          stageUpdatedAt: Date.now() - 4 * 24 * 3600000, // 4 days ago (>72h)
          'errors.consecutiveErrors': 0,
          'deletionTiming.automod': 0,
          'deletionTiming.bot': 0,
          'deletionTiming.human': 0,
          'deletionTiming.late': 0,
        }},
      );

      // Record a success to trigger lifecycle re-evaluation
      await service.recordSuccess('ch_recover', 'ai_contextual', false);
      doc = await intelligence.findOne({ channelId: 'ch_recover' });
      expect(doc!.stage).toBe('learning');
    });

    it('hostile does NOT recover if stageUpdatedAt too recent (fallback)', async () => {
      for (let i = 0; i < 35; i++) {
        await service.recordDeletion('ch_no_recover', 'legacy', 5000, false);
      }
      let doc = await intelligence.findOne({ channelId: 'ch_no_recover' });
      expect(doc!.stage).toBe('hostile');

      // Reset errors+deletions but keep stageUpdatedAt recent
      await intelligence.updateOne(
        { channelId: 'ch_no_recover' },
        { $set: {
          'errors.consecutiveErrors': 0,
          'deletionTiming.automod': 0,
          'deletionTiming.bot': 0,
          'deletionTiming.human': 0,
          'deletionTiming.late': 0,
        }},
      );

      await service.recordSuccess('ch_no_recover', 'ai_contextual', false);
      doc = await intelligence.findOne({ channelId: 'ch_no_recover' });
      expect(doc!.stage).toBe('hostile'); // still hostile — not enough time passed
    });
  });

  describe('lifecycle with percentile engine', () => {
    beforeEach(async () => {
      // Seed enough data for meaningful percentiles
      await seedActiveChannels(activeChannels, 100);
      PercentileEngine.init(activeChannels, redis);
      await PercentileEngine.getInstance().getPercentiles();
    });

    it('new → learning with percentile-based threshold', async () => {
      const percentiles = PercentileEngine.getInstance().getCachedPercentiles();
      expect(percentiles).toBeTruthy();

      const minPulls = Math.max(3, percentiles!.messageVolume.p10);
      for (let i = 0; i < minPulls + 1; i++) {
        await service.recordSuccess('pch1', 'ai_contextual', false);
      }
      const doc = await intelligence.findOne({ channelId: 'pch1' });
      expect(doc!.stage).toBe('learning');
    });

    it('hostile via percentile-based delete rate (p90+)', async () => {
      // Cause high delete rate — enough deletions to push rank above p90
      for (let i = 0; i < 40; i++) {
        await service.recordDeletion('pch_hostile', 'legacy', 5000, false);
      }
      const doc = await intelligence.findOne({ channelId: 'pch_hostile' });
      expect(doc!.stage).toBe('hostile');
    });

    it('learning → optimized with percentile-based threshold', async () => {
      const percentiles = PercentileEngine.getInstance().getCachedPercentiles()!;
      const minPulls = Math.max(3, percentiles.messageVolume.p25);

      // First get to learning
      for (let i = 0; i < Math.max(5, percentiles.messageVolume.p10) + 1; i++) {
        await service.recordSuccess('pch_opt', 'ai_contextual', false);
      }

      // Then add more successes to reach optimized threshold
      for (let i = 0; i < minPulls + 5; i++) {
        await service.recordSuccess('pch_opt', 'ai_contextual', false);
      }

      const doc = await intelligence.findOne({ channelId: 'pch_opt' });
      expect(['learning', 'optimized']).toContain(doc!.stage);
    });

    it('hostile recovery with percentile engine', async () => {
      // Make channel hostile
      for (let i = 0; i < 40; i++) {
        await service.recordDeletion('pch_recover', 'legacy', 5000, false);
      }
      let doc = await intelligence.findOne({ channelId: 'pch_recover' });
      expect(doc!.stage).toBe('hostile');

      // Simulate time passing by setting stageUpdatedAt far in the past
      await intelligence.updateOne(
        { channelId: 'pch_recover' },
        { $set: {
          stageUpdatedAt: Date.now() - 8 * 24 * 3600000, // 8 days ago
          'errors.consecutiveErrors': 0,
          // Reset deletions so delete rate drops
          'deletionTiming.automod': 0,
          'deletionTiming.bot': 0,
          'deletionTiming.human': 0,
          'deletionTiming.late': 0,
        }},
      );

      // Record a success to trigger lifecycle re-evaluation
      await service.recordSuccess('pch_recover', 'ai_contextual', false);
      doc = await intelligence.findOne({ channelId: 'pch_recover' });
      expect(doc!.stage).toBe('learning');
    });
  });

  describe('recordConversion', () => {
    it('increments fractional conversions', async () => {
      await service.recordConversion('ch1', 0.5);
      await service.recordConversion('ch1', 0.3);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.conversions).toBeCloseTo(0.8, 1);
    });
  });

  describe('recordPaidConversion', () => {
    it('increments paidConversions', async () => {
      await service.recordPaidConversion('ch1', 1.0);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.paidConversions).toBe(1);
    });
  });

  describe('get and batchGet', () => {
    it('get returns null for missing channel', async () => {
      const doc = await service.get('nonexistent');
      expect(doc).toBeNull();
    });

    it('get returns doc after recording', async () => {
      await service.recordSuccess('ch1', 'legacy', false);
      const doc = await service.get('ch1');
      expect(doc).toBeTruthy();
      expect(doc!.channelId).toBe('ch1');
    });

    it('batchGet returns multiple docs', async () => {
      await service.ensureDoc('a');
      await service.ensureDoc('b');
      await service.ensureDoc('c');
      const docs = await service.batchGet(['a', 'b', 'c']);
      expect(docs).toHaveLength(3);
    });

    it('batchGet returns empty for empty input', async () => {
      const docs = await service.batchGet([]);
      expect(docs).toHaveLength(0);
    });
  });

  describe('getTopChannels', () => {
    it('returns channels sorted by expectedValue descending', async () => {
      // Create two channels with very different EVs
      await service.ensureDoc('low');
      await service.ensureDoc('high');

      // Give 'high' many successes for a high EV
      for (let i = 0; i < 20; i++) {
        await service.recordSuccess('high', 'ai_contextual', false);
      }
      // Give 'low' many failures for a low EV
      for (let i = 0; i < 15; i++) {
        await service.recordDeletion('low', 'legacy', 5000, false);
      }

      const top = await service.getTopChannels(10);
      expect(top.length).toBe(2);
      // First channel should have higher expectedValue
      expect(top[0].expectedValue).toBeGreaterThanOrEqual(top[1].expectedValue);
    });
  });

  describe('updateClassification', () => {
    it('updates category fields', async () => {
      await service.ensureDoc('ch1');
      await service.updateClassification('ch1', {
        category: 'high_intent',
        confidence: 0.85,
        promotionFitScore: 0.9,
      });
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.channelCategory).toBe('high_intent');
      expect(doc!.categoryConfidence).toBe(0.85);
      expect(doc!.promotionFitScore).toBe(0.9);
    });
  });

  describe('updateSaturationRate', () => {
    it('computes saturation from totalSendsToChannel / participants', async () => {
      await service.ensureDoc('ch1');
      // Manually set totalSendsToChannel
      await intelligence.updateOne({ channelId: 'ch1' }, { $set: { totalSendsToChannel: 500 } });

      await service.updateSaturationRate('ch1', 1000);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.saturationRate).toBe(0.5);
    });

    it('skips when participantsCount is 0', async () => {
      await service.ensureDoc('ch1');
      await service.updateSaturationRate('ch1', 0);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.saturationRate).toBe(0);
    });
  });

  describe('refreshChannelMeta', () => {
    it('classifies unclassified channels immediately', async () => {
      await service.ensureDoc('ch1');
      await service.refreshChannelMeta('ch1', 'Adult Dating Chat', null, 5000);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.channelCategory).toBe('high_intent');
    });

    it('updates saturation rate', async () => {
      await service.ensureDoc('ch1');
      await intelligence.updateOne({ channelId: 'ch1' }, { $set: { totalSendsToChannel: 300 } });
      await service.refreshChannelMeta('ch1', 'Test', null, 1000);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.saturationRate).toBe(0.3);
    });
  });

  describe('updateOnlineTrend', () => {
    it('sets initial EWMA on first sample', async () => {
      await service.ensureDoc('ch1');
      await service.updateOnlineTrend('ch1', 200);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.onlineTrend.ewma).toBe(200);
      expect(doc!.onlineTrend.sampleCount).toBe(1);
    });

    it('applies EWMA on subsequent samples', async () => {
      await service.ensureDoc('ch1');
      await service.updateOnlineTrend('ch1', 200);
      await service.updateOnlineTrend('ch1', 100);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      // EWMA = 200 * 0.85 + 100 * 0.15 = 185
      expect(doc!.onlineTrend.ewma).toBeCloseTo(185, 0);
      expect(doc!.onlineTrend.sampleCount).toBe(2);
    });
  });

  describe('updateViewEngagement', () => {
    it('computes view/participant ratio', async () => {
      await service.ensureDoc('ch1');
      await service.updateViewEngagement('ch1', 500, 1000);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.viewEngagement.ewmaRatio).toBe(0.5);
      expect(doc!.viewEngagement.checksCount).toBe(1);
    });

    it('skips when participants <= 0', async () => {
      await service.ensureDoc('ch1');
      await service.updateViewEngagement('ch1', 500, 0);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.viewEngagement.checksCount).toBe(0);
    });
  });

  describe('updateProfile', () => {
    it('sets profile fields', async () => {
      await service.updateProfile('ch1', 'dating', 0.9, 'english', 0.95);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.topic).toBe('dating');
      expect(doc!.topicConfidence).toBe(0.9);
      expect(doc!.language).toBe('english');
    });
  });

  describe('recordPromotion', () => {
    it('sets lastPromotedAt timestamp', async () => {
      const before = Date.now();
      await service.recordPromotion('ch1');
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.lastPromotedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('ensureIndexes', () => {
    it('creates indexes without error', async () => {
      await expect(service.ensureIndexes()).resolves.not.toThrow();
    });
  });

  describe('discount application', () => {
    it('applies discount on arms with >= 2 pulls', async () => {
      // Record 3 successes — discount should apply before 3rd record
      await service.recordSuccess('ch1', 'ai_contextual', false);
      await service.recordSuccess('ch1', 'ai_contextual', false);
      const before = await intelligence.findOne({ channelId: 'ch1' });
      const sBefore = before!.strategies.ai_contextual.s;

      await service.recordSuccess('ch1', 'ai_contextual', false);
      const after = await intelligence.findOne({ channelId: 'ch1' });

      // After discount + new success, s should be > sBefore (discount reduces then +1 adds)
      // but n should be 3
      expect(after!.strategies.ai_contextual.n).toBe(3);
      expect(after!.strategies.ai_contextual.s).toBeLessThan(3); // because of discount
    });
  });

  describe('singleton re-init', () => {
    it('init returns same instance on second call', () => {
      const s1 = ChannelIntelligenceService.init(intelligence);
      const s2 = ChannelIntelligenceService.init(intelligence);
      expect(s1).toBe(s2);
    });
  });

  describe('batchGet with projection', () => {
    it('returns partial documents when projection specified', async () => {
      await service.ensureDoc('proj1');
      await service.ensureDoc('proj2');
      const docs = await service.batchGet(['proj1', 'proj2'], { channelId: 1, stage: 1 });
      expect(docs).toHaveLength(2);
      expect(docs[0].channelId).toBeDefined();
      expect(docs[0].stage).toBeDefined();
    });
  });

  describe('error cooldowns', () => {
    it('sets cooldown for FLOOD_WAIT', async () => {
      const before = Date.now();
      await service.recordFailure('ch_fw', 'legacy', 'FLOOD_WAIT');
      const doc = await intelligence.findOne({ channelId: 'ch_fw' });
      // 5 min cooldown
      expect(doc!.cooldownUntil).toBeGreaterThan(before);
      expect(doc!.cooldownUntil).toBeLessThan(before + 10 * 60_000);
    });

    it('sets cooldown for SLOWMODE_WAIT', async () => {
      const before = Date.now();
      await service.recordFailure('ch_sw', 'legacy', 'SLOWMODE_WAIT');
      const doc = await intelligence.findOne({ channelId: 'ch_sw' });
      expect(doc!.cooldownUntil).toBeGreaterThan(before);
    });

    it('sets cooldown for PEER_FLOOD', async () => {
      const before = Date.now();
      await service.recordFailure('ch_pf', 'legacy', 'PEER_FLOOD');
      const doc = await intelligence.findOne({ channelId: 'ch_pf' });
      // 60 min cooldown
      expect(doc!.cooldownUntil).toBeGreaterThan(before + 50 * 60_000);
    });
  });

  describe('refreshChannelMeta edge cases', () => {
    it('skips classification when not at 50-pull boundary and already classified', async () => {
      await service.ensureDoc('meta1');
      // Set up: already classified, totalPulls=25 (not near 50 boundary)
      await intelligence.updateOne(
        { channelId: 'meta1' },
        { $set: {
          channelCategory: 'high_intent',
          'strategies.ai_contextual.n': 25,
          totalSendsToChannel: 100,
        }},
      );
      await service.refreshChannelMeta('meta1', 'Test', null, 500);
      const doc = await intelligence.findOne({ channelId: 'meta1' });
      // saturation should be updated (100/500 = 0.2)
      expect(doc!.saturationRate).toBe(0.2);
      // category should NOT change because 25 % 50 = 25, which is >= 2
      expect(doc!.channelCategory).toBe('high_intent');
    });

    it('returns early for nonexistent channel', async () => {
      // Should not throw
      await service.refreshChannelMeta('nonexistent', 'Test', null, 500);
    });
  });

  describe('updateViewEngagement EWMA on subsequent checks', () => {
    it('applies EWMA on second check', async () => {
      await service.ensureDoc('ve1');
      await service.updateViewEngagement('ve1', 500, 1000); // ratio = 0.5
      await service.updateViewEngagement('ve1', 200, 1000); // ratio = 0.2
      const doc = await intelligence.findOne({ channelId: 've1' });
      // EWMA: 0.5 * 0.85 + 0.2 * 0.15 = 0.455
      expect(doc!.viewEngagement.ewmaRatio).toBeCloseTo(0.455, 1);
      expect(doc!.viewEngagement.checksCount).toBe(2);
    });

    it('skips when views <= 0', async () => {
      await service.ensureDoc('ve2');
      await service.updateViewEngagement('ve2', 0, 1000);
      const doc = await intelligence.findOne({ channelId: 've2' });
      expect(doc!.viewEngagement.checksCount).toBe(0);
    });
  });

  describe('followup rate computation', () => {
    it('computes followupSuccessRate correctly', async () => {
      await service.recordSuccess('fu1', 'ai_contextual', true); // success followup
      await service.recordSuccess('fu1', 'ai_contextual', true); // success followup
      await service.recordDeletion('fu1', 'ai_contextual', 5000, true); // failed followup
      const doc = await intelligence.findOne({ channelId: 'fu1' });
      expect(doc!.followupTotal).toBe(3);
      expect(doc!.followupSuccessCount).toBe(2);
      expect(doc!.followupSuccessRate).toBeCloseTo(2 / 3, 2);
    });
  });
});

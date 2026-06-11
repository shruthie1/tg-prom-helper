import { Collection } from 'mongodb';
import { setupMongo, teardownMongo, createRedis, seedActiveChannels } from './helpers';
import { ChannelIntelligenceService, createDefaultIntelligence, PercentileEngine, type ChannelIntelligenceDocument } from '../src';
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

    it('replace option swaps the singleton instance', () => {
      const first = ChannelIntelligenceService.init(intelligence);
      const second = ChannelIntelligenceService.init(intelligence, { replace: true });

      expect(second).not.toBe(first);
      expect(ChannelIntelligenceService.getInstance()).toBe(second);
    });

    it('ignores malformed init options from JavaScript callers', () => {
      const first = ChannelIntelligenceService.init(intelligence);
      const second = ChannelIntelligenceService.init(intelligence, null as any);

      expect(second).toBe(first);
      expect(ChannelIntelligenceService.getInstance()).toBe(first);
    });

    it('fails fast for malformed direct constructor and init collections', () => {
      expect(() => new ChannelIntelligenceService(null as any))
        .toThrow('ChannelIntelligenceService collection is required');
      expect(() => ChannelIntelligenceService.init({ findOne: () => null } as any, { replace: true }))
        .toThrow('ChannelIntelligenceService collection is required');
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

    it('trims channel ids and ignores blank ids before creating docs', async () => {
      await service.ensureDoc('  ch_trimmed  ');
      await service.ensureDoc('   ');
      await service.ensureDoc(null as unknown as string);

      expect(await intelligence.findOne({ channelId: 'ch_trimmed' })).toBeTruthy();
      expect(await intelligence.countDocuments({})).toBe(1);
    });

    it('normalizes Telegram peer-prefixed channel ids before creating or reading docs', async () => {
      await service.ensureDoc('-10012345');
      await service.recordSuccess('-12345', 'legacy', false);

      expect(await intelligence.findOne({ channelId: '12345' })).toBeTruthy();
      expect(await intelligence.findOne({ channelId: '-10012345' })).toBeNull();
      expect((await service.get('12345'))!.strategies.legacy.s).toBe(1);
      expect((await service.batchGet(['-10012345', '12345']))).toHaveLength(1);
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
      await service.recordFailure('ch1', 'legacy', 'TRANSIENT');
      await service.recordFailure('ch1', 'legacy', 'TRANSIENT');
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

    it('normalizes invalid success strategies to legacy before writing counters', async () => {
      await service.recordSuccess('invalid_strategy_success', 'bad_strategy' as any, false);
      const doc = await intelligence.findOne({ channelId: 'invalid_strategy_success' });

      expect(doc!.strategies.legacy.s).toBe(1);
      expect((doc!.strategies as Record<string, unknown>)['bad_strategy']).toBeUndefined();
    });

    it('repairs corrupted nested intelligence state before recording success', async () => {
      await service.ensureDoc('corrupt_success');
      await intelligence.updateOne(
        { channelId: 'corrupt_success' },
        { $set: {
          strategies: null as unknown as ChannelIntelligenceDocument['strategies'],
          deletionTiming: null as unknown as ChannelIntelligenceDocument['deletionTiming'],
          errors: null as unknown as ChannelIntelligenceDocument['errors'],
          onlineTrend: null as unknown as ChannelIntelligenceDocument['onlineTrend'],
          viewEngagement: null as unknown as ChannelIntelligenceDocument['viewEngagement'],
        }},
      );

      await service.recordSuccess('corrupt_success', 'legacy', false);
      const doc = await intelligence.findOne({ channelId: 'corrupt_success' });

      expect(doc!.strategies.legacy.s).toBe(1);
      expect(doc!.strategies.legacy.n).toBe(1);
      expect(doc!.errors.consecutiveErrors).toBe(0);
      expect(doc!.expectedValue).toBeGreaterThan(0);
    });

    it('repairs corrupted numeric intelligence leaves before Mongo increment writes', async () => {
      await service.ensureDoc('corrupt_numeric_success');
      await intelligence.updateOne(
        { channelId: 'corrupt_numeric_success' },
        { $set: {
          'strategies.legacy.s': 'bad',
          'strategies.legacy.f': Number.NaN,
          'strategies.legacy.n': 'bad',
          totalSendsToChannel: 'bad' as unknown as number,
          'deletionTiming.automod': 'bad',
          'errors.TRANSIENT': 'bad',
          'errors.consecutiveErrors': 'bad',
        }},
      );

      await service.recordSuccess('corrupt_numeric_success', 'legacy', false);
      const doc = await intelligence.findOne({ channelId: 'corrupt_numeric_success' });

      expect(doc!.strategies.legacy.s).toBe(1);
      expect(doc!.strategies.legacy.f).toBe(0);
      expect(doc!.strategies.legacy.n).toBe(1);
      expect(doc!.deletionTiming.automod).toBe(0);
      expect(doc!.errors.TRANSIENT).toBe(0);
      expect(doc!.errors.consecutiveErrors).toBe(0);
      expect(doc!.totalSendsToChannel).toBe(1);
    });

    it('repairs corrupted follow-up success counters before Mongo increment writes', async () => {
      await service.ensureDoc('corrupt_followup_success');
      await intelligence.updateOne(
        { channelId: 'corrupt_followup_success' },
        { $set: {
          followupTotal: 'bad' as unknown as number,
          followupSuccessCount: Number.NaN,
          totalSendsToChannel: 'bad' as unknown as number,
        }},
      );

      await service.recordSuccess('corrupt_followup_success', 'legacy', true);
      const doc = await intelligence.findOne({ channelId: 'corrupt_followup_success' });

      expect(doc!.followupTotal).toBe(1);
      expect(doc!.followupSuccessCount).toBe(1);
      expect(doc!.totalSendsToChannel).toBe(1);
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

    it('classifies malformed survival time as automod instead of late deletion', async () => {
      await service.recordDeletion('ch_bad_survival', 'legacy', Number.NaN, false);
      const doc = await intelligence.findOne({ channelId: 'ch_bad_survival' });
      expect(doc!.deletionTiming.automod).toBe(1);
      expect(doc!.deletionTiming.late).toBe(0);
    });

    it('increments followupTotal on followup deletion', async () => {
      await service.recordDeletion('ch1', 'legacy', 5000, true);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.followupTotal).toBe(1);
      // NOT followupSuccessCount — deletion is not a success
    });

    it('repairs corrupted follow-up deletion counters before Mongo increment writes', async () => {
      await service.ensureDoc('corrupt_followup_deletion');
      await intelligence.updateOne(
        { channelId: 'corrupt_followup_deletion' },
        { $set: { followupTotal: 'bad' as unknown as number } },
      );

      await service.recordDeletion('corrupt_followup_deletion', 'legacy', 5000, true);
      const doc = await intelligence.findOne({ channelId: 'corrupt_followup_deletion' });

      expect(doc!.followupTotal).toBe(1);
    });

    it('normalizes invalid deletion strategies to legacy before writing counters', async () => {
      await service.recordDeletion('invalid_strategy_delete', 'bad_strategy' as any, 5000, false);
      const doc = await intelligence.findOne({ channelId: 'invalid_strategy_delete' });

      expect(doc!.strategies.legacy.f).toBe(1);
      expect((doc!.strategies as Record<string, unknown>)['bad_strategy']).toBeUndefined();
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

    it('classifies terminal Telegram channel errors as restricted cooldowns', async () => {
      const before = Date.now();
      await service.recordFailure('ch_forbidden', 'legacy', 'CHANNEL_PRIVATE');
      const doc = await intelligence.findOne({ channelId: 'ch_forbidden' });

      expect(doc!.errors.CHANNEL_RESTRICTED).toBe(1);
      expect(doc!.errors.TRANSIENT ?? 0).toBe(0);
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

    it('normalizes malformed error type before storing failure metadata', async () => {
      await service.recordFailure('ch1', 'legacy', null as unknown as string);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.errors.TRANSIENT).toBe(1);
      expect(doc!.errors.lastErrorType).toBe('TRANSIENT');
    });

    it('normalizes invalid failure strategies to legacy before writing counters', async () => {
      await service.recordFailure('invalid_strategy_failure', 'bad_strategy' as any, 'TRANSIENT');
      const doc = await intelligence.findOne({ channelId: 'invalid_strategy_failure' });

      expect(doc!.strategies.legacy.f).toBe(1);
      expect((doc!.strategies as Record<string, unknown>)['bad_strategy']).toBeUndefined();
    });

    it('normalizes whitespace-padded direct strategy values before Mongo writes', async () => {
      await service.recordFailure('trimmed_strategy_failure', ' ai_contextual ' as any, 'TRANSIENT');
      const doc = await intelligence.findOne({ channelId: 'trimmed_strategy_failure' });

      expect(doc!.strategies.ai_contextual.f).toBe(1);
      expect(doc!.strategies.legacy.f).toBe(0);
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

    it('does NOT transition to hostile from consecutive errors alone (account-level concern)', async () => {
      for (let i = 0; i < 7; i++) {
        await service.recordFailure('ch1', 'legacy', 'TRANSIENT');
      }
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      // Hostile only from deletion rate, not from send errors
      expect(doc!.stage).not.toBe('hostile');
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

    it('ignores invalid conversion weights and clamps oversized weights', async () => {
      await service.recordConversion('ch_invalid', -1);
      await service.recordConversion('ch_invalid', Number.NaN);
      expect(await intelligence.findOne({ channelId: 'ch_invalid' })).toBeNull();

      await service.recordConversion('ch_invalid', 2);
      const doc = await intelligence.findOne({ channelId: 'ch_invalid' });
      expect(doc!.conversions).toBe(1);
    });

    it('refreshes expected value after conversion writes', async () => {
      await service.ensureDoc('ch_score');
      await intelligence.updateOne(
        { channelId: 'ch_score' },
        { $set: { expectedValue: 0.01, scoreUpdatedAt: 1 } },
      );

      await service.recordConversion('ch_score', 1);

      const doc = await intelligence.findOne({ channelId: 'ch_score' });
      expect(doc!.expectedValue).toBeGreaterThan(0.01);
      expect(doc!.scoreUpdatedAt).toBeGreaterThan(1);
    });

    it('repairs corrupted conversion counters before Mongo increment writes', async () => {
      await service.ensureDoc('conversion_corrupt');
      await intelligence.updateOne(
        { channelId: 'conversion_corrupt' },
        { $set: { conversions: 'bad' as unknown as number } },
      );

      await service.recordConversion('conversion_corrupt', 0.5);

      const doc = await intelligence.findOne({ channelId: 'conversion_corrupt' });
      expect(doc!.conversions).toBe(0.5);
    });
  });

  describe('recordPaidConversion', () => {
    it('increments paidConversions', async () => {
      await service.recordPaidConversion('ch1', 1.0);
      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.paidConversions).toBe(1);
    });

    it('refreshes expected value after paid conversion writes', async () => {
      await service.ensureDoc('paid_score');
      await intelligence.updateOne(
        { channelId: 'paid_score' },
        { $set: { expectedValue: 0.01, scoreUpdatedAt: 1 } },
      );

      await service.recordPaidConversion('paid_score', 1);

      const doc = await intelligence.findOne({ channelId: 'paid_score' });
      expect(doc!.expectedValue).toBeGreaterThan(0.01);
      expect(doc!.scoreUpdatedAt).toBeGreaterThan(1);
    });

    it('ignores invalid paid conversion weights and clamps oversized weights', async () => {
      await service.recordPaidConversion('paid_invalid', 0);
      await service.recordPaidConversion('paid_invalid', Number.POSITIVE_INFINITY);
      expect(await intelligence.findOne({ channelId: 'paid_invalid' })).toBeNull();

      await service.recordPaidConversion('paid_invalid', 5);
      const doc = await intelligence.findOne({ channelId: 'paid_invalid' });
      expect(doc!.paidConversions).toBe(1);
    });

    it('repairs corrupted paid conversion counters before Mongo increment writes', async () => {
      await service.ensureDoc('paid_conversion_corrupt');
      await intelligence.updateOne(
        { channelId: 'paid_conversion_corrupt' },
        { $set: { paidConversions: Number.NaN } },
      );

      await service.recordPaidConversion('paid_conversion_corrupt', 0.75);

      const doc = await intelligence.findOne({ channelId: 'paid_conversion_corrupt' });
      expect(doc!.paidConversions).toBe(0.75);
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

    it('normalizes batch ids before querying', async () => {
      await service.ensureDoc('a');
      await service.ensureDoc('b');

      const docs = await service.batchGet([' a ', 'a', '', null as unknown as string, 'b']);

      expect(docs.map(doc => doc.channelId).sort()).toEqual(['a', 'b']);
    });

    it('treats malformed cursor output as empty read results', async () => {
      const malformedService = new ChannelIntelligenceService({
        findOne: async () => null,
        find: () => ({ toArray: async () => null }),
        updateOne: async () => undefined,
        findOneAndUpdate: async () => null,
        createIndex: async () => undefined,
      } as any);

      await expect(malformedService.batchGet(['a'])).resolves.toEqual([]);
      await expect(malformedService.getTopChannels(10)).resolves.toEqual([]);
    });

    it('filters malformed rows from cursor output', async () => {
      const row = createDefaultIntelligence('valid-row');
      const malformedService = new ChannelIntelligenceService({
        findOne: async () => null,
        find: () => ({
          sort: () => ({
            limit: () => ({
              toArray: async () => [null, { channelId: '   ' }, row],
            }),
          }),
          limit: () => ({
            toArray: async () => [null, { channelId: '   ' }, row],
          }),
          toArray: async () => [null, { channelId: '   ' }, row],
        }),
        updateOne: async () => undefined,
        findOneAndUpdate: async () => null,
        createIndex: async () => undefined,
      } as any);

      await expect(malformedService.batchGet(['valid-row'])).resolves.toEqual([row]);
      await expect(malformedService.getTopChannels(10)).resolves.toEqual([row]);
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
      // Give 'low' some successes but also failures for a low EV (but not hostile)
      for (let i = 0; i < 5; i++) {
        await service.recordSuccess('low', 'legacy', false);
      }
      for (let i = 0; i < 3; i++) {
        await service.recordDeletion('low', 'legacy', 5000, false);
      }

      const top = await service.getTopChannels(10);
      expect(top.length).toBe(2);
      // First channel should have higher expectedValue
      expect(top[0]!.expectedValue).toBeGreaterThanOrEqual(top[1]!.expectedValue);
    });

    it('normalizes malformed limits instead of passing them to Mongo', async () => {
      await service.ensureDoc('limit_a');
      await service.ensureDoc('limit_b');

      const top = await service.getTopChannels(Number.NaN);

      expect(top.map(doc => doc.channelId).sort()).toEqual(['limit_a', 'limit_b']);
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

    it('clamps malformed classification fields before writing', async () => {
      await service.ensureDoc('ch_class_bad');
      await service.updateClassification('ch_class_bad', {
        category: 'bad-category' as any,
        confidence: Number.POSITIVE_INFINITY,
        promotionFitScore: -5,
      });
      const doc = await intelligence.findOne({ channelId: 'ch_class_bad' });
      expect(doc!.channelCategory).toBe('unclassified');
      expect(doc!.categoryConfidence).toBe(0);
      expect(doc!.promotionFitScore).toBe(0);
    });

    it('normalizes malformed classification objects from JavaScript callers', async () => {
      await service.ensureDoc('ch_class_null');
      await service.updateClassification('ch_class_null', null as any);
      const doc = await intelligence.findOne({ channelId: 'ch_class_null' });
      expect(doc!.channelCategory).toBe('unclassified');
      expect(doc!.categoryConfidence).toBe(0);
      expect(doc!.promotionFitScore).toBe(0);
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

    it('does not write NaN saturation from malformed counters', async () => {
      await service.ensureDoc('sat_bad');
      await intelligence.updateOne({ channelId: 'sat_bad' }, { $set: { totalSendsToChannel: Number.NaN } });

      await service.updateSaturationRate('sat_bad', Number.POSITIVE_INFINITY);
      let doc = await intelligence.findOne({ channelId: 'sat_bad' });
      expect(doc!.saturationRate).toBe(0);

      await service.updateSaturationRate('sat_bad', 1000);
      doc = await intelligence.findOne({ channelId: 'sat_bad' });
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

    it('uses safe counters while refreshing metadata', async () => {
      await service.ensureDoc('meta_bad');
      await intelligence.updateOne(
        { channelId: 'meta_bad' },
        { $set: {
          totalSendsToChannel: Number.NaN,
          'strategies.ai_contextual.n': Number.NaN,
        }},
      );
      await service.refreshChannelMeta('meta_bad', 'Dating Chat', null, 1000);
      const doc = await intelligence.findOne({ channelId: 'meta_bad' });
      expect(doc!.saturationRate).toBe(0);
      expect(doc!.channelCategory).toBe('high_intent');
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

    it('sanitizes malformed online trend inputs and stored samples', async () => {
      await service.ensureDoc('online_bad');
      await intelligence.updateOne(
        { channelId: 'online_bad' },
        { $set: { 'onlineTrend.ewma': Number.NaN, 'onlineTrend.sampleCount': Number.NaN } },
      );

      await service.updateOnlineTrend('online_bad', Number.NaN);
      const doc = await intelligence.findOne({ channelId: 'online_bad' });
      expect(doc!.onlineTrend.ewma).toBe(0);
      expect(doc!.onlineTrend.sampleCount).toBe(1);
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

    it('sanitizes malformed view engagement inputs and stored counters', async () => {
      await service.ensureDoc('views_bad');
      await intelligence.updateOne(
        { channelId: 'views_bad' },
        { $set: { 'viewEngagement.ewmaRatio': Number.NaN, 'viewEngagement.checksCount': Number.NaN } },
      );

      await service.updateViewEngagement('views_bad', 500, 1000);
      const doc = await intelligence.findOne({ channelId: 'views_bad' });
      expect(doc!.viewEngagement.ewmaRatio).toBe(0.5);
      expect(doc!.viewEngagement.checksCount).toBe(1);
    });

    it('records zero-view checks as low engagement samples', async () => {
      await service.ensureDoc('views_zero');
      await service.updateViewEngagement('views_zero', 0, 1000);
      const doc = await intelligence.findOne({ channelId: 'views_zero' });
      expect(doc!.viewEngagement.ewmaRatio).toBe(0);
      expect(doc!.viewEngagement.checksCount).toBe(1);
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

    it('normalizes blank profile labels and clamps confidences', async () => {
      await service.updateProfile('profile_bad', '   ', 5, '', Number.NaN);
      const doc = await intelligence.findOne({ channelId: 'profile_bad' });
      expect(doc!.topic).toBe('general_chat');
      expect(doc!.topicConfidence).toBe(1);
      expect(doc!.language).toBe('unknown');
      expect(doc!.languageConfidence).toBe(0);
    });

    it('normalizes malformed profile labels from JavaScript callers', async () => {
      await service.updateProfile('profile_malformed', null as unknown as string, 0.4, 123 as unknown as string, 0.6);
      const doc = await intelligence.findOne({ channelId: 'profile_malformed' });
      expect(doc!.topic).toBe('general_chat');
      expect(doc!.topicConfidence).toBe(0.4);
      expect(doc!.language).toBe('unknown');
      expect(doc!.languageConfidence).toBe(0.6);
    });

    it('uses normalized channel ids for direct profile writes', async () => {
      await service.updateProfile('  profile_trimmed  ', 'dating', 0.9, 'english', 0.9);

      expect(await intelligence.findOne({ channelId: 'profile_trimmed' })).toBeTruthy();
      expect(await intelligence.findOne({ channelId: '  profile_trimmed  ' })).toBeNull();
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

      await service.recordSuccess('ch1', 'ai_contextual', false);
      const after = await intelligence.findOne({ channelId: 'ch1' });

      // After discount + new success, s should be > sBefore (discount reduces then +1 adds)
      // but n should be 3
      expect(after!.strategies.ai_contextual.n).toBe(3);
      expect(after!.strategies.ai_contextual.s).toBeLessThan(3); // because of discount
    });

    it('applies discount before direct send-failure outcomes', async () => {
      await service.recordFailure('failure_discount', 'legacy', 'TRANSIENT');
      await service.recordFailure('failure_discount', 'legacy', 'TRANSIENT');

      await service.recordFailure('failure_discount', 'legacy', 'TRANSIENT');
      const after = await intelligence.findOne({ channelId: 'failure_discount' });

      expect(after!.strategies.legacy.n).toBe(3);
      expect(after!.strategies.legacy.f).toBeLessThan(3);
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
      expect(docs[0]!.channelId).toBeDefined();
      expect(docs[0]!.stage).toBeDefined();
    });
  });

  describe('error cooldowns', () => {
    it('does NOT set cooldown for account-specific FLOOD_WAIT', async () => {
      await service.recordFailure('ch_fw', 'legacy', 'FLOOD_WAIT');
      const doc = await intelligence.findOne({ channelId: 'ch_fw' });
      expect(doc!.cooldownUntil).toBe(0);
    });

    it('does NOT set cooldown for account-specific FLOOD_WAIT with seconds', async () => {
      await service.recordFailure('ch_fw_long', 'legacy', 'FLOOD_WAIT_3600');
      const doc = await intelligence.findOne({ channelId: 'ch_fw_long' });
      expect(doc!.cooldownUntil).toBe(0);
    });

    it('does NOT set cooldown for account-specific SLOWMODE_WAIT', async () => {
      await service.recordFailure('ch_sw', 'legacy', 'SLOWMODE_WAIT');
      const doc = await intelligence.findOne({ channelId: 'ch_sw' });
      expect(doc!.cooldownUntil).toBe(0);
    });

    it('does NOT set cooldown for account-specific PEER_FLOOD', async () => {
      await service.recordFailure('ch_pf', 'legacy', 'PEER_FLOOD');
      const doc = await intelligence.findOne({ channelId: 'ch_pf' });
      expect(doc!.cooldownUntil).toBe(0);
    });

    it('sets cooldown for channel-level CHANNEL_PRIVATE', async () => {
      const before = Date.now();
      await service.recordFailure('ch_priv', 'legacy', 'CHANNEL_PRIVATE');
      const doc = await intelligence.findOne({ channelId: 'ch_priv' });
      expect(doc!.cooldownUntil).toBeGreaterThan(before + 6 * 24 * 3600000);
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

    it('records zero views as a valid engagement check', async () => {
      await service.ensureDoc('ve2');
      await service.updateViewEngagement('ve2', 0, 1000);
      const doc = await intelligence.findOne({ channelId: 've2' });
      expect(doc!.viewEngagement.ewmaRatio).toBe(0);
      expect(doc!.viewEngagement.checksCount).toBe(1);
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

    it('scores follow-up outcomes with the newly computed follow-up rate in the same write', async () => {
      await service.ensureDoc('fu_score_fresh');
      await intelligence.updateOne(
        { channelId: 'fu_score_fresh' },
        { $set: {
          followupTotal: 4,
          followupSuccessCount: 4,
          followupSuccessRate: 0.1,
          'strategies.legacy.s': 1,
          'strategies.legacy.f': 9,
          'strategies.legacy.n': 10,
        }},
      );

      await service.recordSuccess('fu_score_fresh', 'legacy', true);

      const doc = await intelligence.findOne({ channelId: 'fu_score_fresh' });
      expect(doc!.followupSuccessRate).toBe(1);
      expect(doc!.expectedValue).toBeGreaterThan(0.55);
    });
  });
});

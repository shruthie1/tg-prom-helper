import { Collection } from 'mongodb';
import { setupMongo, teardownMongo, createRedis, seedActiveChannels, insertActiveChannel } from './helpers';
import { PercentileEngine } from '../src/channel-intelligence/percentile-engine';
import type { ChannelPercentiles } from '../src/types';
import type { Redis } from 'ioredis';

describe('PercentileEngine', () => {
  let activeChannels: Collection;
  let intelligence: Collection;
  let redis: Redis;
  let engine: PercentileEngine;

  beforeAll(async () => {
    const mongo = await setupMongo();
    activeChannels = mongo.activeChannels;
    intelligence = mongo.intelligence as unknown as Collection;
    redis = createRedis();
  });

  afterAll(async () => {
    await redis.quit();
    await teardownMongo();
  });

  beforeEach(async () => {
    await activeChannels.deleteMany({});
    await redis.flushall();
    // Reset singleton for fresh engine each test
    (PercentileEngine as any).instance = undefined;
  });

  describe('init and singleton', () => {
    it('creates singleton on first init', () => {
      engine = PercentileEngine.init(activeChannels, redis);
      expect(engine).toBeInstanceOf(PercentileEngine);
    });

    it('returns same instance on subsequent init', () => {
      const e1 = PercentileEngine.init(activeChannels, redis);
      const e2 = PercentileEngine.init(activeChannels, redis);
      expect(e1).toBe(e2);
    });

    it('getInstance returns instance after init', () => {
      PercentileEngine.init(activeChannels, redis);
      expect(PercentileEngine.getInstance()).toBeInstanceOf(PercentileEngine);
    });

    it('getInstance throws before init', () => {
      expect(() => PercentileEngine.getInstance()).toThrow('PercentileEngine not initialized');
    });
  });

  describe('getPercentiles — computation from real data', () => {
    beforeEach(async () => {
      engine = PercentileEngine.init(activeChannels, redis);
    });

    it('computes percentiles from 100 channels', async () => {
      await seedActiveChannels(activeChannels, 100);

      const p = await engine.getPercentiles();

      // Basic structural checks
      expect(p.successRate).toBeDefined();
      expect(p.deleteRate).toBeDefined();
      expect(p.participantsCount).toBeDefined();
      expect(p.messageVolume).toBeDefined();
      expect(p.saturationRate).toBeDefined();
      expect(p.followupSurvivalRate).toBeDefined();
      expect(p.conversionRate).toBeDefined();

      // Percentile ordering: p10 <= p25 <= p50 <= p75 <= p90
      for (const key of ['successRate', 'deleteRate', 'participantsCount', 'messageVolume'] as const) {
        const b = p[key];
        expect(b.p10).toBeLessThanOrEqual(b.p25);
        expect(b.p25).toBeLessThanOrEqual(b.p50);
        expect(b.p50).toBeLessThanOrEqual(b.p75);
        expect(b.p75).toBeLessThanOrEqual(b.p90);
        expect(b.count).toBeGreaterThan(0);
      }
    });

    it('returns zero buckets for empty collection', async () => {
      const p = await engine.getPercentiles();

      expect(p.successRate.count).toBe(0);
      expect(p.successRate.p50).toBe(0);
      expect(p.participantsCount.count).toBe(0);
    });

    it('handles single channel', async () => {
      await insertActiveChannel(activeChannels, {
        channelId: 'single',
        successMsgCount: 10,
        failureMsgCount: 2,
        deletedCount: 1,
        participantsCount: 500,
      });

      const p = await engine.getPercentiles();
      // Single value: all percentiles should be the same
      expect(p.participantsCount.p10).toBe(p.participantsCount.p90);
    });

    it('excludes banned and forbidden channels', async () => {
      // Insert 5 normal + 5 banned
      for (let i = 0; i < 5; i++) {
        await insertActiveChannel(activeChannels, {
          channelId: `normal_${i}`,
          successMsgCount: 100,
          failureMsgCount: 10,
          participantsCount: 1000 + i * 100,
        });
      }
      for (let i = 0; i < 5; i++) {
        await insertActiveChannel(activeChannels, {
          channelId: `banned_${i}`,
          successMsgCount: 100,
          failureMsgCount: 10,
          participantsCount: 50000, // very high — should NOT appear
          banned: true,
        });
      }

      const p = await engine.getPercentiles();
      // participants p90 should be from normal channels (~1400), not banned (50000)
      expect(p.participantsCount.p90).toBeLessThan(5000);
    });

    it('computes saturation from successMsgCount + followupMsgSuccessCount / participantsCount', async () => {
      for (let i = 0; i < 10; i++) {
        await insertActiveChannel(activeChannels, {
          channelId: `sat_${i}`,
          successMsgCount: 100 * (i + 1),
          followupMsgSuccessCount: 50 * (i + 1),
          participantsCount: 1000,
        });
      }

      const p = await engine.getPercentiles();
      expect(p.saturationRate.count).toBeGreaterThan(0);
      // Channel 0: (100+50)/1000 = 0.15, Channel 9: (1000+500)/1000 = 1.5
      expect(p.saturationRate.p10).toBeLessThan(p.saturationRate.p90);
    });
  });

  describe('Redis caching', () => {
    beforeEach(async () => {
      engine = PercentileEngine.init(activeChannels, redis);
    });

    it('caches to Redis after computation', async () => {
      await seedActiveChannels(activeChannels, 50);
      await engine.getPercentiles();

      const cached = await redis.get('percentiles:channels');
      expect(cached).toBeTruthy();
      const parsed: ChannelPercentiles = JSON.parse(cached!);
      expect(parsed.successRate).toBeDefined();
    });

    it('serves from Redis on second call', async () => {
      await seedActiveChannels(activeChannels, 50);

      const p1 = await engine.getPercentiles();

      // Wipe MongoDB but keep Redis — and clear in-memory cache to force Redis read
      await activeChannels.deleteMany({});
      (engine as any).cache = null;
      (engine as any).lastComputed = 0;

      // Should read from Redis now (not in-memory, not MongoDB)
      const p2 = await engine.getPercentiles();
      expect(p2.successRate.count).toBe(p1.successRate.count);
    });

    it('serves from in-memory cache within refresh window', async () => {
      await seedActiveChannels(activeChannels, 20);
      const p1 = await engine.getPercentiles();

      // Wipe both MongoDB and Redis
      await activeChannels.deleteMany({});
      await redis.flushall();

      // Within 30-min window: should use in-memory cache
      const p2 = await engine.getPercentiles();
      expect(p2.successRate.count).toBe(p1.successRate.count);
    });

    it('falls back to computation when Redis has invalid JSON', async () => {
      await seedActiveChannels(activeChannels, 30);

      // Put invalid JSON in Redis
      await redis.set('percentiles:channels', 'NOT_VALID_JSON', 'EX', 3600);

      // Force cache miss
      (engine as any).cache = null;
      (engine as any).lastComputed = 0;

      // Should still succeed by falling through to computeAndCache
      const p = await engine.getPercentiles();
      expect(p.successRate).toBeDefined();
      expect(p.successRate.count).toBeGreaterThan(0);
    });
  });

  describe('getPercentileRank / getPercentileRankSync', () => {
    beforeEach(async () => {
      engine = PercentileEngine.init(activeChannels, redis);

      // Seed known distribution
      for (let i = 0; i < 100; i++) {
        await insertActiveChannel(activeChannels, {
          channelId: `rank_${i}`,
          participantsCount: (i + 1) * 100, // 100 to 10000
          successMsgCount: 50 + i * 5,
          failureMsgCount: 10,
          deletedCount: Math.floor(i * 0.5),
        });
      }
      await engine.getPercentiles(); // load cache
    });

    it('returns rank between 0 and 1', async () => {
      const rank = await engine.getPercentileRank(5000, 'participantsCount');
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThanOrEqual(1);
    });

    it('low values get low rank', async () => {
      const rank = await engine.getPercentileRank(100, 'participantsCount');
      expect(rank).toBeLessThan(0.3);
    });

    it('high values get high rank', async () => {
      const rank = await engine.getPercentileRank(9500, 'participantsCount');
      expect(rank).toBeGreaterThan(0.7);
    });

    it('sync version matches async when cached', async () => {
      const asyncRank = await engine.getPercentileRank(5000, 'participantsCount');
      const syncRank = engine.getPercentileRankSync(5000, 'participantsCount');
      expect(syncRank).toBeCloseTo(asyncRank, 2);
    });

    it('sync version returns 0.5 when no cache', () => {
      (PercentileEngine as any).instance = undefined;
      const fresh = PercentileEngine.init(activeChannels, redis);
      // No getPercentiles() called yet — cache is null
      const rank = fresh.getPercentileRankSync(5000, 'participantsCount');
      expect(rank).toBe(0.5);
    });

    it('interpolates between buckets correctly', async () => {
      const p = await engine.getPercentiles();
      const mid = (p.participantsCount.p25 + p.participantsCount.p50) / 2;
      const rank = engine.getPercentileRankSync(mid, 'participantsCount');
      // Should be between 0.25 and 0.50
      expect(rank).toBeGreaterThan(0.25);
      expect(rank).toBeLessThan(0.50);
    });
  });

  describe('getCachedPercentiles', () => {
    it('returns null before any computation', () => {
      engine = PercentileEngine.init(activeChannels, redis);
      expect(engine.getCachedPercentiles()).toBeNull();
    });

    it('returns data after computation', async () => {
      engine = PercentileEngine.init(activeChannels, redis);
      await seedActiveChannels(activeChannels, 10);
      await engine.getPercentiles();
      expect(engine.getCachedPercentiles()).toBeTruthy();
    });
  });

  describe('intelligence collection integration', () => {
    it('computes followupSurvivalRate from intelligence collection', async () => {
      engine = PercentileEngine.init(activeChannels, redis, intelligence);
      await seedActiveChannels(activeChannels, 20);

      // Seed intelligence docs with followup data
      for (let i = 0; i < 20; i++) {
        await intelligence.insertOne({
          channelId: `intel_${i}`,
          followupTotal: 10 + i,
          followupSuccessCount: Math.floor((10 + i) * (0.3 + i * 0.03)),
          conversions: i * 0.1,
          totalSendsToChannel: 50 + i * 10,
        } as any);
      }

      const p = await engine.getPercentiles();
      // Should have computed from intelligence collection, not defaults
      expect(p.followupSurvivalRate.count).toBeGreaterThan(0);
    });

    it('falls back to defaults when intelligence collection unavailable', async () => {
      engine = PercentileEngine.init(activeChannels, redis); // no intelligence collection
      await seedActiveChannels(activeChannels, 20);

      const p = await engine.getPercentiles();
      // followupSurvivalRate should be defaults
      expect(p.followupSurvivalRate.p50).toBe(0.5);
      expect(p.followupSurvivalRate.count).toBe(0);
    });
  });
});

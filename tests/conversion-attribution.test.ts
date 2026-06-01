import { Collection } from 'mongodb';
import { setupMongo, teardownMongo, createRedis } from './helpers';
import { ConversionAttributionService } from '../src';
import { ChannelIntelligenceService, type ChannelIntelligenceDocument } from '../src';
import { RedisPromotionTracker } from '../src';
import type { Redis } from 'ioredis';

describe('ConversionAttributionService', () => {
  let intelligence: Collection<ChannelIntelligenceDocument>;
  let redis: Redis;
  let intelService: ChannelIntelligenceService;
  let tracker: RedisPromotionTracker;
  let attribution: ConversionAttributionService;

  beforeAll(async () => {
    const mongo = await setupMongo();
    intelligence = mongo.intelligence;
    redis = createRedis();
  });

  afterAll(async () => {
    await redis.quit();
    await teardownMongo();
  });

  beforeEach(async () => {
    await intelligence.deleteMany({});
    await redis.flushall();
    (ChannelIntelligenceService as any).instance = undefined;
    (RedisPromotionTracker as any).instance = undefined;
    (ConversionAttributionService as any).instance = undefined;

    intelService = new ChannelIntelligenceService(intelligence);
    tracker = new RedisPromotionTracker(redis);
    attribution = new ConversionAttributionService(intelService, tracker);
  });

  describe('singleton', () => {
    it('init and getInstance work', () => {
      const a = ConversionAttributionService.init(intelService, tracker);
      expect(ConversionAttributionService.getInstance()).toBe(a);
    });

    it('replaces singleton when explicitly requested', () => {
      const first = ConversionAttributionService.init(intelService, tracker);
      const secondTracker = new RedisPromotionTracker(redis);
      const second = ConversionAttributionService.init(intelService, secondTracker, { replace: true });

      expect(second).not.toBe(first);
      expect(ConversionAttributionService.getInstance()).toBe(second);
    });

    it('ignores malformed init options from JavaScript callers', () => {
      const first = ConversionAttributionService.init(intelService, tracker);
      const secondTracker = new RedisPromotionTracker(redis);
      const second = ConversionAttributionService.init(intelService, secondTracker, null as any);

      expect(second).toBe(first);
      expect(ConversionAttributionService.getInstance()).toBe(first);
    });

    it('fails fast for malformed direct constructor dependencies', () => {
      expect(() => new ConversionAttributionService(null as any, tracker))
        .toThrow('ConversionAttributionService intelligence service is required');
      expect(() => new ConversionAttributionService(intelService, null as any))
        .toThrow('ConversionAttributionService promotion tracker is required');
    });

    it('getInstance throws before init', () => {
      expect(() => ConversionAttributionService.getInstance()).toThrow();
    });
  });

  describe('attributeConversion', () => {
    it('returns empty for no common chats', async () => {
      const result = await attribution.attributeConversion([]);
      expect(result.attributedChannels).toHaveLength(0);
    });

    it('returns empty when no promotions found in Redis', async () => {
      const result = await attribution.attributeConversion(['ch1', 'ch2']);
      expect(result.attributedChannels).toHaveLength(0);
    });

    it('attributes to single channel', async () => {
      // Record a recent promotion
      await tracker.recordSend('ch1', '+919999', 'client1');

      const result = await attribution.attributeConversion(['ch1']);
      expect(result.attributedChannels).toHaveLength(1);
      const attributed = result.attributedChannels[0];
      expect(attributed).toBeDefined();
      expect(attributed!.channelId).toBe('ch1');
      expect(attributed!.mobile).toBe('+919999');
      expect(attributed!.weight).toBeCloseTo(1.0, 1); // single channel gets ~100%
    });

    it('deduplicates duplicate common chat IDs before attribution', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');

      const result = await attribution.attributeConversion(['ch1', 'ch1', 'ch1']);
      const doc = await intelligence.findOne({ channelId: 'ch1' });

      expect(result.attributedChannels).toEqual([
        expect.objectContaining({
          channelId: 'ch1',
          mobile: '+919999',
          weight: expect.closeTo(1.0, 1),
        }),
      ]);
      expect(doc!.conversions).toBeCloseTo(1.0, 5);
    });

    it('normalizes common chat ids before lookup and conversion recording', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');

      const result = await attribution.attributeConversion([' ch1 ', '', 'ch1']);
      const trimmedDoc = await intelligence.findOne({ channelId: 'ch1' });
      const untrimmedDoc = await intelligence.findOne({ channelId: ' ch1 ' });

      expect(result.attributedChannels).toEqual([
        expect.objectContaining({ channelId: 'ch1', mobile: '+919999' }),
      ]);
      expect(trimmedDoc!.conversions).toBeCloseTo(1.0, 5);
      expect(untrimmedDoc).toBeNull();
    });

    it('normalizes numeric Telegram common chat ids before Redis lookup', async () => {
      await tracker.recordSend('12345', '+919999', 'client1');
      await tracker.recordSend('-100777', '+918888', 'client2');

      const result = await attribution.attributeConversion([12345, BigInt(-100777), Number.NaN, 1.2]);
      const channelIds = result.attributedChannels.map(a => a.channelId).sort();
      const positiveDoc = await intelligence.findOne({ channelId: '12345' });
      const strippedDoc = await intelligence.findOne({ channelId: '777' });
      const prefixedDoc = await intelligence.findOne({ channelId: '-100777' });

      expect(channelIds).toEqual(['12345', '777']);
      expect(positiveDoc!.conversions).toBeGreaterThan(0);
      expect(strippedDoc!.conversions).toBeGreaterThan(0);
      expect(prefixedDoc).toBeNull();
    });

    it('matches Telegram peer-prefixed common chats to stripped stored channel ids', async () => {
      await tracker.recordSend('777', '+919999', 'client1');

      const result = await attribution.attributeConversion([BigInt(-100777)]);
      const strippedDoc = await intelligence.findOne({ channelId: '777' });
      const prefixedDoc = await intelligence.findOne({ channelId: '-100777' });

      expect(result.attributedChannels).toEqual([
        expect.objectContaining({ channelId: '777', mobile: '+919999' }),
      ]);
      expect(strippedDoc!.conversions).toBeCloseTo(1.0, 5);
      expect(prefixedDoc).toBeNull();
    });

    it('deduplicates raw and peer-prefixed common chats that resolve to the same channel', async () => {
      await tracker.recordSend('777', '+919999', 'client1');

      const result = await attribution.attributeConversion(['777', '-100777']);
      const strippedDoc = await intelligence.findOne({ channelId: '777' });

      expect(result.attributedChannels).toEqual([
        expect.objectContaining({ channelId: '777', mobile: '+919999' }),
      ]);
      expect(strippedDoc!.conversions).toBeCloseTo(1.0, 5);
    });

    it('uses the canonical promoter across equivalent channel id shapes', async () => {
      const now = Date.now();
      await redis.set(
        'promote:channel:-100777:lastMobile',
        JSON.stringify({ mobile: '+91stale', clientId: 'old-client', timestamp: now - 3 * 3600000 }),
        'EX', 7200,
      );
      await redis.set(
        'promote:channel:777:lastMobile',
        JSON.stringify({ mobile: '+91fresh', clientId: 'new-client', timestamp: now - 1000 }),
        'EX', 7200,
      );

      const result = await attribution.attributeConversion(['-100777']);
      const strippedDoc = await intelligence.findOne({ channelId: '777' });
      const prefixedDoc = await intelligence.findOne({ channelId: '-100777' });

      expect(result.attributedChannels).toEqual([
        expect.objectContaining({ channelId: '777', mobile: '+91fresh' }),
      ]);
      expect(strippedDoc!.conversions).toBeCloseTo(1.0, 5);
      expect(prefixedDoc).toBeNull();
    });

    it('returns empty for malformed common chat input', async () => {
      const result = await attribution.attributeConversion(null as unknown as string[]);
      expect(result.attributedChannels).toHaveLength(0);
    });

    it('keeps channel last-promoter data for the full attribution window', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      const ttl = await redis.ttl('promote:channel:ch1:lastMobile');
      expect(ttl).toBeGreaterThan(3600);
    });

    it('records conversion to intelligence', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      await attribution.attributeConversion(['ch1']);

      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc).toBeTruthy();
      expect(doc!.conversions).toBeGreaterThan(0);
    });

    it('records paid conversion when isPaid=true', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      await attribution.attributeConversion(['ch1'], true);

      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.paidConversions).toBeGreaterThan(0);
    });

    it('does not record paidConversion when isPaid=false', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      await attribution.attributeConversion(['ch1'], false);

      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.paidConversions).toBe(0);
    });

    it('does not record paid conversion for truthy malformed isPaid values', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      await attribution.attributeConversion(['ch1'], 'true' as unknown as boolean);

      const doc = await intelligence.findOne({ channelId: 'ch1' });
      expect(doc!.conversions).toBeGreaterThan(0);
      expect(doc!.paidConversions).toBe(0);
    });

    it('weights multiple channels by recency (exponential decay)', async () => {
      // Record sends at different times
      // We can't easily control timestamps since recordSend uses Date.now(),
      // so we test with direct Redis manipulation
      const now = Date.now();

      // Channel 1: promoted 1 minute ago (recent — heavy weight)
      await redis.set(
        'promote:channel:ch1:lastMobile',
        JSON.stringify({ mobile: '+91m1', clientId: 'c1', timestamp: now - 60000 }),
        'EX', 3600,
      );

      // Channel 2: promoted 30 minutes ago (old — light weight)
      await redis.set(
        'promote:channel:ch2:lastMobile',
        JSON.stringify({ mobile: '+91m2', clientId: 'c2', timestamp: now - 30 * 60000 }),
        'EX', 3600,
      );

      const result = await attribution.attributeConversion(['ch1', 'ch2']);
      expect(result.attributedChannels.length).toBeGreaterThanOrEqual(1);

      // ch1 should have higher weight (more recent)
      const ch1 = result.attributedChannels.find(a => a.channelId === 'ch1');
      const ch2 = result.attributedChannels.find(a => a.channelId === 'ch2');

      if (ch1 && ch2) {
        expect(ch1.weight).toBeGreaterThan(ch2.weight);
      }
    });

    it('skips channels promoted more than 2 hours ago', async () => {
      const now = Date.now();
      await redis.set(
        'promote:channel:old_ch:lastMobile',
        JSON.stringify({ mobile: '+91m1', clientId: 'c1', timestamp: now - 3 * 3600000 }),
        'EX', 7200,
      );

      const result = await attribution.attributeConversion(['old_ch']);
      expect(result.attributedChannels).toHaveLength(0);
    });

    it('skips future-dated promotion records instead of over-crediting them', async () => {
      const now = Date.now();
      await redis.set(
        'promote:channel:future_ch:lastMobile',
        JSON.stringify({ mobile: '+91future', clientId: 'c1', timestamp: now + 30 * 60000 }),
        'EX', 7200,
      );

      const result = await attribution.attributeConversion(['future_ch']);
      const doc = await intelligence.findOne({ channelId: 'future_ch' });

      expect(result.attributedChannels).toHaveLength(0);
      expect(doc).toBeNull();
    });

    it('filters out attributions with weight < 5%', async () => {
      const now = Date.now();

      // 1 very recent + 1 very old (but within 2h)
      await redis.set(
        'promote:channel:recent:lastMobile',
        JSON.stringify({ mobile: '+91m1', clientId: 'c1', timestamp: now - 1000 }),
        'EX', 3600,
      );
      await redis.set(
        'promote:channel:old:lastMobile',
        JSON.stringify({ mobile: '+91m2', clientId: 'c2', timestamp: now - 100 * 60000 }), // 100 min ago
        'EX', 7200,
      );

      const result = await attribution.attributeConversion(['recent', 'old']);
      // The very old channel should have negligible weight after exponential decay
      // and may be filtered out if < 5%
      const recentAttribution = result.attributedChannels.find(a => a.channelId === 'recent');
      expect(recentAttribution).toBeTruthy();
    });

    it('renormalizes kept attribution weights after dropping negligible channels', async () => {
      const now = Date.now();
      await redis.set(
        'promote:channel:recent:lastMobile',
        JSON.stringify({ mobile: '+91m1', clientId: 'c1', timestamp: now - 1000 }),
        'EX', 3600,
      );
      await redis.set(
        'promote:channel:old:lastMobile',
        JSON.stringify({ mobile: '+91m2', clientId: 'c2', timestamp: now - 100 * 60000 }),
        'EX', 7200,
      );

      const result = await attribution.attributeConversion(['recent', 'old']);
      const recentDoc = await intelligence.findOne({ channelId: 'recent' });
      const oldDoc = await intelligence.findOne({ channelId: 'old' });

      expect(result.attributedChannels).toEqual([
        expect.objectContaining({
          channelId: 'recent',
          weight: expect.closeTo(1, 5),
        }),
      ]);
      expect(recentDoc!.conversions).toBeCloseTo(1, 5);
      expect(oldDoc).toBeNull();
    });

    it('handles weight normalization correctly', async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await redis.set(
          `promote:channel:ch${i}:lastMobile`,
          JSON.stringify({ mobile: `+91m${i}`, clientId: `c${i}`, timestamp: now - i * 60000 }),
          'EX', 3600,
        );
      }

      const result = await attribution.attributeConversion(['ch0', 'ch1', 'ch2', 'ch3', 'ch4']);

      // Weights should sum to ~1.0
      const totalWeight = result.attributedChannels.reduce((sum, a) => sum + a.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 1);
    });

    it('returns empty on internal error (catch block)', async () => {
      // Create attribution with broken tracker to trigger catch
      const brokenTracker = {
        getLastPromoter: () => { throw new Error('Redis connection lost'); },
      } as any;
      const brokenAttribution = new ConversionAttributionService(intelService, brokenTracker);
      const result = await brokenAttribution.attributeConversion(['ch1']);
      expect(result.attributedChannels).toHaveLength(0);
    });

    it('continues attribution when one tracker lookup fails', async () => {
      const now = Date.now();
      const flakyTracker = {
        getLastPromoter: (channelId: string) => {
          if (channelId === 'bad') throw new Error('Redis connection lost');
          return { mobile: ' +919999 ', clientId: ' client1 ', timestamp: now - 1000 };
        },
      } as any;
      const flakyAttribution = new ConversionAttributionService(intelService, flakyTracker);

      const result = await flakyAttribution.attributeConversion(['bad', 'good']);

      expect(result.attributedChannels).toEqual([
        expect.objectContaining({
          channelId: 'good',
          mobile: '+919999',
          weight: expect.closeTo(1, 5),
        }),
      ]);
    });

    it('returns discovered attribution even when analytics persistence fails', async () => {
      const now = Date.now();
      const workingTracker = {
        getLastPromoter: () => ({ mobile: '+919999', clientId: 'client1', timestamp: now - 1000 }),
      } as any;
      const brokenIntel = {
        recordConversion: () => { throw new Error('mongo write failed'); },
        recordPaidConversion: () => { throw new Error('mongo write failed'); },
      } as any;
      const resilientAttribution = new ConversionAttributionService(brokenIntel, workingTracker);

      const result = await resilientAttribution.attributeConversion(['good'], true);

      expect(result.attributedChannels).toEqual([
        expect.objectContaining({
          channelId: 'good',
          mobile: '+919999',
          weight: expect.closeTo(1, 5),
        }),
      ]);
    });
  });
});

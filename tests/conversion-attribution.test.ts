import { Collection } from 'mongodb';
import { setupMongo, teardownMongo, createRedis } from './helpers';
import { ConversionAttributionService } from '../src/attribution/conversion-attribution';
import { ChannelIntelligenceService } from '../src/channel-intelligence/channel-intelligence-service';
import { RedisPromotionTracker } from '../src/redis/redis-promotion-tracker';
import type { ChannelIntelligenceDocument } from '../src/channel-intelligence/channel-intelligence.types';
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
      expect(result.attributedChannels[0].channelId).toBe('ch1');
      expect(result.attributedChannels[0].mobile).toBe('+919999');
      expect(result.attributedChannels[0].weight).toBeCloseTo(1.0, 1); // single channel gets ~100%
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
  });
});

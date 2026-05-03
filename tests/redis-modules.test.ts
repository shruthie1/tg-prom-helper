import { createRedis } from './helpers';
import { RedisChannelLock } from '../src/redis/redis-channel-lock';
import { RedisPromotionTracker } from '../src/redis/redis-promotion-tracker';
import type { Redis } from 'ioredis';

describe('RedisChannelLock', () => {
  let redis: Redis;
  let lock: RedisChannelLock;

  beforeAll(() => {
    redis = createRedis();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushall();
    (RedisChannelLock as any).instance = undefined;
    lock = new RedisChannelLock(redis);
  });

  describe('singleton', () => {
    it('init and getInstance work', () => {
      const l = RedisChannelLock.init(redis);
      expect(RedisChannelLock.getInstance()).toBe(l);
    });

    it('init returns same instance on second call', () => {
      const l1 = RedisChannelLock.init(redis);
      const l2 = RedisChannelLock.init(redis);
      expect(l1).toBe(l2);
    });

    it('getInstance throws before init', () => {
      expect(() => RedisChannelLock.getInstance()).toThrow();
    });
  });

  describe('markPromoted / isRecentlyPromoted', () => {
    it('returns false for unlocked channel', async () => {
      expect(await lock.isRecentlyPromoted('ch1')).toBe(false);
    });

    it('returns true after marking', async () => {
      await lock.markPromoted('ch1', '+919999');
      expect(await lock.isRecentlyPromoted('ch1')).toBe(true);
    });

    it('different channels are independent', async () => {
      await lock.markPromoted('ch1', '+919999');
      expect(await lock.isRecentlyPromoted('ch1')).toBe(true);
      expect(await lock.isRecentlyPromoted('ch2')).toBe(false);
    });
  });

  describe('getPromoter', () => {
    it('returns null for unlocked channel', async () => {
      expect(await lock.getPromoter('ch1')).toBeNull();
    });

    it('returns mobile number after marking', async () => {
      await lock.markPromoted('ch1', '+919876543210');
      expect(await lock.getPromoter('ch1')).toBe('+919876543210');
    });
  });
});

describe('RedisPromotionTracker', () => {
  let redis: Redis;
  let tracker: RedisPromotionTracker;

  beforeAll(() => {
    redis = createRedis();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushall();
    (RedisPromotionTracker as any).instance = undefined;
    tracker = new RedisPromotionTracker(redis);
  });

  describe('singleton', () => {
    it('init and getInstance work', () => {
      const t = RedisPromotionTracker.init(redis);
      expect(RedisPromotionTracker.getInstance()).toBe(t);
    });

    it('init returns same instance on second call', () => {
      const t1 = RedisPromotionTracker.init(redis);
      const t2 = RedisPromotionTracker.init(redis);
      expect(t1).toBe(t2);
    });

    it('getInstance throws before init', () => {
      expect(() => RedisPromotionTracker.getInstance()).toThrow();
    });
  });

  describe('recordSend', () => {
    it('stores mobile history', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      const history = await tracker.getMobileHistory('+919999');
      expect(history).toHaveLength(1);
      expect(history[0].channelId).toBe('ch1');
      expect(history[0].mobile).toBe('+919999');
      expect(history[0].clientId).toBe('client1');
    });

    it('stores channel lastMobile', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      const last = await tracker.getLastPromoter('ch1');
      expect(last).toBeTruthy();
      expect(last!.mobile).toBe('+919999');
    });

    it('maintains order (newest first)', async () => {
      await tracker.recordSend('ch1', '+91mob', 'c1');
      await tracker.recordSend('ch2', '+91mob', 'c1');
      await tracker.recordSend('ch3', '+91mob', 'c1');

      const history = await tracker.getMobileHistory('+91mob');
      expect(history).toHaveLength(3);
      // lpush = newest first
      expect(history[0].channelId).toBe('ch3');
      expect(history[2].channelId).toBe('ch1');
    });

    it('overwrites lastMobile on same channel', async () => {
      await tracker.recordSend('ch1', '+91first', 'c1');
      await tracker.recordSend('ch1', '+91second', 'c2');

      const last = await tracker.getLastPromoter('ch1');
      expect(last!.mobile).toBe('+91second');
    });
  });

  describe('getMobileHistory', () => {
    it('returns empty for unknown mobile', async () => {
      const history = await tracker.getMobileHistory('+91unknown');
      expect(history).toHaveLength(0);
    });

    it('caps at 50 entries', async () => {
      for (let i = 0; i < 60; i++) {
        await tracker.recordSend(`ch_${i}`, '+91mob', 'c1');
      }
      const history = await tracker.getMobileHistory('+91mob');
      expect(history.length).toBeLessThanOrEqual(50);
    });
  });

  describe('getLastPromoter', () => {
    it('returns null for unknown channel', async () => {
      const last = await tracker.getLastPromoter('unknown');
      expect(last).toBeNull();
    });
  });
});

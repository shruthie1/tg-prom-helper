import { createRedis } from './helpers';
import { RedisChannelLock, RedisPromotionTracker } from '../src';
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

    it('replace option swaps the singleton instance', () => {
      const l1 = RedisChannelLock.init(redis);
      const l2 = RedisChannelLock.init(redis, { replace: true });
      expect(l2).not.toBe(l1);
      expect(RedisChannelLock.getInstance()).toBe(l2);
    });

    it('ignores malformed init options from JavaScript callers', () => {
      const l1 = RedisChannelLock.init(redis);
      const l2 = RedisChannelLock.init(redis, null as any);
      expect(l2).toBe(l1);
    });

    it('getInstance throws before init', () => {
      expect(() => RedisChannelLock.getInstance()).toThrow();
    });

    it('fails fast for malformed direct constructor and init redis clients', () => {
      expect(() => new RedisChannelLock(null as unknown as Redis))
        .toThrow('RedisChannelLock redis client is required');
      expect(() => RedisChannelLock.init({ set: () => undefined } as unknown as Redis))
        .toThrow('RedisChannelLock redis client is required');
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

    it('accepts string and boolean Redis exists results from compatible clients', async () => {
      const stringExistsLock = new RedisChannelLock({
        get: async () => null,
        set: async () => 'OK',
        exists: async () => '1',
      } as any);
      const booleanExistsLock = new RedisChannelLock({
        get: async () => null,
        set: async () => 'OK',
        exists: async () => true,
      } as any);

      await expect(stringExistsLock.isRecentlyPromoted('ch1')).resolves.toBe(true);
      await expect(booleanExistsLock.isRecentlyPromoted('ch1')).resolves.toBe(true);
    });

    it('different channels are independent', async () => {
      await lock.markPromoted('ch1', '+919999');
      expect(await lock.isRecentlyPromoted('ch1')).toBe(true);
      expect(await lock.isRecentlyPromoted('ch2')).toBe(false);
    });

    it('ignores blank channel or mobile identifiers', async () => {
      await lock.markPromoted('', '+919999');
      await lock.markPromoted('ch1', '   ');
      await lock.markPromoted(null as unknown as string, '+919999');

      expect(await lock.isRecentlyPromoted('')).toBe(false);
      expect(await lock.isRecentlyPromoted(null as unknown as string)).toBe(false);
      expect(await lock.isRecentlyPromoted('ch1')).toBe(false);
      expect(await redis.keys('promote:lock:*')).toEqual([]);
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

    it('trims key identifiers before writing and reading lock state', async () => {
      await lock.markPromoted(' ch1 ', ' +919876543210 ');
      expect(await lock.getPromoter('ch1')).toBe('+919876543210');
    });

    it('normalizes Telegram peer-prefixed channel ids for lock keys', async () => {
      await lock.markPromoted('-100777', '+919876543210');

      expect(await lock.isRecentlyPromoted('777')).toBe(true);
      expect(await lock.getPromoter('-777')).toBe('+919876543210');
      expect(await redis.exists('promote:lock:777')).toBe(1);
      expect(await redis.exists('promote:lock:-100777')).toBe(0);
    });

    it('normalizes externally written promoter values before returning them', async () => {
      await redis.set('promote:lock:external', ' +919876543210 ', 'EX', 1800);
      await redis.set('promote:lock:blank', '   ', 'EX', 1800);

      expect(await lock.getPromoter('external')).toBe('+919876543210');
      expect(await lock.getPromoter('blank')).toBeNull();
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

    it('replace option swaps the singleton instance', () => {
      const t1 = RedisPromotionTracker.init(redis);
      const t2 = RedisPromotionTracker.init(redis, { replace: true });
      expect(t2).not.toBe(t1);
      expect(RedisPromotionTracker.getInstance()).toBe(t2);
    });

    it('ignores malformed init options from JavaScript callers', () => {
      const t1 = RedisPromotionTracker.init(redis);
      const t2 = RedisPromotionTracker.init(redis, null as any);
      expect(t2).toBe(t1);
    });

    it('getInstance throws before init', () => {
      expect(() => RedisPromotionTracker.getInstance()).toThrow();
    });

    it('fails fast for malformed direct constructor and init redis clients', () => {
      expect(() => new RedisPromotionTracker(null as unknown as Redis))
        .toThrow('RedisPromotionTracker redis client is required');
      expect(() => RedisPromotionTracker.init({ get: () => null } as unknown as Redis))
        .toThrow('RedisPromotionTracker redis client is required');
      expect(() => RedisPromotionTracker.getInstance()).toThrow();
    });
  });

  describe('recordSend', () => {
    it('stores mobile history', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      const history = await tracker.getMobileHistory('+919999');
      expect(history).toHaveLength(1);
      const first = history[0];
      expect(first).toBeDefined();
      expect(first!.channelId).toBe('ch1');
      expect(first!.mobile).toBe('+919999');
      expect(first!.clientId).toBe('client1');
    });

    it('stores channel lastMobile', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      const last = await tracker.getLastPromoter('ch1');
      expect(last).toBeTruthy();
      expect(last!.mobile).toBe('+919999');
    });

    it('uses one timestamp for mobile history and channel last promoter', async () => {
      await tracker.recordSend('ch1', '+919999', 'client1');
      const history = await tracker.getMobileHistory('+919999');
      const last = await tracker.getLastPromoter('ch1');

      expect(history[0]!.timestamp).toBe(last!.timestamp);
    });

    it('maintains order (newest first)', async () => {
      await tracker.recordSend('ch1', '+91mob', 'c1');
      await tracker.recordSend('ch2', '+91mob', 'c1');
      await tracker.recordSend('ch3', '+91mob', 'c1');

      const history = await tracker.getMobileHistory('+91mob');
      expect(history).toHaveLength(3);
      // lpush = newest first
      expect(history[0]!.channelId).toBe('ch3');
      expect(history[2]!.channelId).toBe('ch1');
    });

    it('overwrites lastMobile on same channel', async () => {
      await tracker.recordSend('ch1', '+91first', 'c1');
      await tracker.recordSend('ch1', '+91second', 'c2');

      const last = await tracker.getLastPromoter('ch1');
      expect(last!.mobile).toBe('+91second');
    });

    it('ignores blank channel, mobile, or client identifiers', async () => {
      await tracker.recordSend('', '+91mob', 'client1');
      await tracker.recordSend('ch1', '   ', 'client1');
      await tracker.recordSend('ch2', '+91mob', '');
      await tracker.recordSend(null as unknown as string, '+91mob', 'client1');

      expect(await tracker.getMobileHistory('+91mob')).toEqual([]);
      expect(await tracker.getLastPromoter('ch1')).toBeNull();
      expect(await tracker.getLastPromoter('ch2')).toBeNull();
      expect(await redis.keys('promote:*')).toEqual([]);
    });

    it('trims identifiers before writing tracker records', async () => {
      await tracker.recordSend(' ch1 ', ' +91mob ', ' client1 ');

      expect(await tracker.getMobileHistory('+91mob')).toEqual([
        expect.objectContaining({ channelId: 'ch1', mobile: '+91mob', clientId: 'client1' }),
      ]);
      expect(await tracker.getLastPromoter('ch1')).toEqual(expect.objectContaining({
        mobile: '+91mob',
        clientId: 'client1',
      }));
    });

    it('normalizes Telegram peer-prefixed channel ids for tracker keys and history records', async () => {
      await tracker.recordSend('-100777', '+91mob', 'client1');

      expect(await tracker.getMobileHistory('+91mob')).toEqual([
        expect.objectContaining({ channelId: '777', mobile: '+91mob', clientId: 'client1' }),
      ]);
      expect(await tracker.getLastPromoter('-777')).toEqual(expect.objectContaining({
        mobile: '+91mob',
        clientId: 'client1',
      }));
      expect(await redis.exists('promote:channel:777:lastMobile')).toBe(1);
      expect(await redis.exists('promote:channel:-100777:lastMobile')).toBe(0);
    });

    it('fails fast when a compatible Redis client returns a malformed pipeline', async () => {
      const malformedPipelineTracker = new RedisPromotionTracker({
        get: async () => null,
        set: async () => 'OK',
        lrange: async () => [],
        pipeline: () => ({ lpush: () => undefined }),
      } as any);

      await expect(malformedPipelineTracker.recordSend('ch1', '+91mob', 'client1'))
        .rejects.toThrow('RedisPromotionTracker redis pipeline is required');
    });

    it('fails visibly when Redis pipeline exec returns command errors', async () => {
      let pipeline: any;
      pipeline = {
        lpush: () => pipeline,
        ltrim: () => pipeline,
        expire: () => pipeline,
        set: () => pipeline,
        exec: async () => [[new Error('lpush failed')]],
      };
      const failingPipelineTracker = new RedisPromotionTracker({
        get: async () => null,
        set: async () => 'OK',
        lrange: async () => [],
        pipeline: () => pipeline,
      } as any);

      await expect(failingPipelineTracker.recordSend('ch1', '+91mob', 'client1'))
        .rejects.toThrow('RedisPromotionTracker redis pipeline exec failed: lpush failed');
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

    it('filters corrupted history entries instead of throwing', async () => {
      await redis.lpush('promote:mobile:+91bad:history', '{bad-json');
      await redis.lpush('promote:mobile:+91bad:history', JSON.stringify({ channelId: 'bad-shape' }));
      await tracker.recordSend('valid', '+91bad', 'client1');

      const history = await tracker.getMobileHistory('+91bad');

      expect(history).toHaveLength(1);
      expect(history[0]!.channelId).toBe('valid');
    });

    it('normalizes valid corrupted-history strings before returning them', async () => {
      await redis.lpush('promote:mobile:+91bad:history', JSON.stringify({
        channelId: ' ch1 ',
        mobile: ' +91bad ',
        clientId: ' client1 ',
        timestamp: Date.now(),
      }));

      const history = await tracker.getMobileHistory('+91bad');

      expect(history).toEqual([
        expect.objectContaining({ channelId: 'ch1', mobile: '+91bad', clientId: 'client1' }),
      ]);
    });

    it('filters future-dated corrupted history entries', async () => {
      await redis.lpush('promote:mobile:+91future:history', JSON.stringify({
        channelId: 'future',
        mobile: '+91future',
        clientId: 'client1',
        timestamp: Date.now() + 60_000,
      }));

      expect(await tracker.getMobileHistory('+91future')).toEqual([]);
    });

    it('filters stale history entries older than the attribution window', async () => {
      await redis.lpush('promote:mobile:+91old:history', JSON.stringify({
        channelId: 'old',
        mobile: '+91old',
        clientId: 'client1',
        timestamp: Date.now() - 3 * 3600000,
      }));

      expect(await tracker.getMobileHistory('+91old')).toEqual([]);
    });

    it('returns empty when a compatible Redis client returns malformed list data', async () => {
      const malformedListTracker = new RedisPromotionTracker({
        get: async () => null,
        set: async () => 'OK',
        lrange: async () => null,
        pipeline: () => ({
          lpush: () => undefined,
          ltrim: () => undefined,
          expire: () => undefined,
          set: () => undefined,
          exec: async () => undefined,
        }),
      } as any);

      await expect(malformedListTracker.getMobileHistory('+91bad')).resolves.toEqual([]);
    });
  });

  describe('getLastPromoter', () => {
    it('returns null for unknown channel', async () => {
      const last = await tracker.getLastPromoter('unknown');
      expect(last).toBeNull();
    });

    it('returns null for corrupted channel last-promoter data', async () => {
      await redis.set('promote:channel:broken:lastMobile', '{bad-json', 'EX', 7200);
      await expect(tracker.getLastPromoter('broken')).resolves.toBeNull();
    });

    it('returns null for valid JSON with invalid last-promoter shape', async () => {
      await redis.set('promote:channel:bad-shape:lastMobile', JSON.stringify({ mobile: '+91bad' }), 'EX', 7200);
      await expect(tracker.getLastPromoter('bad-shape')).resolves.toBeNull();
    });

    it('normalizes valid corrupted last-promoter strings before returning them', async () => {
      await redis.set('promote:channel:trimmed:lastMobile', JSON.stringify({
        mobile: ' +91bad ',
        clientId: ' client1 ',
        timestamp: Date.now(),
      }), 'EX', 7200);

      await expect(tracker.getLastPromoter('trimmed')).resolves.toEqual(expect.objectContaining({
        mobile: '+91bad',
        clientId: 'client1',
      }));
    });

    it('returns null for future-dated last-promoter records', async () => {
      await redis.set('promote:channel:future:lastMobile', JSON.stringify({
        mobile: '+91future',
        clientId: 'client1',
        timestamp: Date.now() + 60_000,
      }), 'EX', 7200);

      await expect(tracker.getLastPromoter('future')).resolves.toBeNull();
    });

    it('returns null for stale last-promoter records older than the attribution window', async () => {
      await redis.set('promote:channel:old:lastMobile', JSON.stringify({
        mobile: '+91old',
        clientId: 'client1',
        timestamp: Date.now() - 3 * 3600000,
      }), 'EX', 7200);

      await expect(tracker.getLastPromoter('old')).resolves.toBeNull();
    });

    it('returns empty/null for blank lookup identifiers', async () => {
      expect(await tracker.getMobileHistory('   ')).toEqual([]);
      expect(await tracker.getMobileHistory(null as unknown as string)).toEqual([]);
      expect(await tracker.getLastPromoter('')).toBeNull();
      expect(await tracker.getLastPromoter(null as unknown as string)).toBeNull();
    });
  });
});

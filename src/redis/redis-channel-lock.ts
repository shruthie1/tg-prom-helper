/**
 * Redis-based cross-account channel dedup.
 *
 * Prevents multiple promote accounts from hitting the same channel
 * within a 30-minute window.
 */

import type { Redis } from 'ioredis';

const LOCK_TTL = 1800; // 30 minutes

export class RedisChannelLock {
  private static instance: RedisChannelLock;

  constructor(private redis: Redis) {}

  static init(redis: Redis): RedisChannelLock {
    if (!RedisChannelLock.instance) {
      RedisChannelLock.instance = new RedisChannelLock(redis);
    }
    return RedisChannelLock.instance;
  }

  static getInstance(): RedisChannelLock {
    if (!RedisChannelLock.instance) {
      throw new Error('RedisChannelLock not initialized. Call init() first.');
    }
    return RedisChannelLock.instance;
  }

  async markPromoted(channelId: string, mobile: string): Promise<void> {
    await this.redis.set(`promote:lock:${channelId}`, mobile, 'EX', LOCK_TTL);
  }

  async isRecentlyPromoted(channelId: string): Promise<boolean> {
    return (await this.redis.exists(`promote:lock:${channelId}`)) === 1;
  }

  async getPromoter(channelId: string): Promise<string | null> {
    return this.redis.get(`promote:lock:${channelId}`);
  }
}

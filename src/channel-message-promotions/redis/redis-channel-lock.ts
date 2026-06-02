/**
 * Redis-based cross-account channel dedup.
 *
 * Prevents multiple promote accounts from hitting the same channel
 * within a short window.
 */

import type { RedisLike } from '../../types';
import { normalizeChannelId } from '../utils/channel-id';

const LOCK_TTL = 300; // 5 minutes

export class RedisChannelLock {
  private static instance: RedisChannelLock | undefined;

  constructor(private redis: RedisLike) {
    if (!isRedisLike(redis)) {
      throw new Error('RedisChannelLock redis client is required');
    }
  }

  static init(redis: RedisLike, options: { replace?: boolean } = {}): RedisChannelLock {
    if (!RedisChannelLock.instance || shouldReplace(options)) {
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

  static reset(): void {
    RedisChannelLock.instance = undefined;
  }

  async markPromoted(channelId: string, mobile: string): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    const safeMobile = normalizeKeyPart(mobile);
    if (!safeChannelId || !safeMobile) return;
    await this.redis.set(`promote:lock:${safeChannelId}`, safeMobile, 'EX', LOCK_TTL);
  }

  async isRecentlyPromoted(channelId: string): Promise<boolean> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return false;
    const exists: unknown = await this.redis.exists(`promote:lock:${safeChannelId}`);
    return exists === 1 || exists === '1' || exists === true;
  }

  async getPromoter(channelId: string): Promise<string | null> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return null;
    return normalizeKeyPart(await this.redis.get(`promote:lock:${safeChannelId}`));
  }
}

function normalizeKeyPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRedisLike(value: unknown): value is RedisLike {
  return isRecord(value)
    && typeof value['get'] === 'function'
    && typeof value['set'] === 'function'
    && typeof value['exists'] === 'function';
}

function shouldReplace(options: unknown): boolean {
  return isRecord(options) && options['replace'] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

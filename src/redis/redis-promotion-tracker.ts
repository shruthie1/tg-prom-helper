/**
 * Mobile-based promotion history for ROI attribution.
 *
 * Tracks which mobile number sent to which channel, enabling
 * accurate conversion attribution via common chats.
 *
 * Key design: mobile-keyed (not client-keyed) because mobiles
 * swap between clients but we need to know which mobile was active
 * when a user responded.
 */

import type { Redis } from 'ioredis';

interface SendRecord {
  channelId: string;
  mobile: string;
  clientId: string;
  timestamp: number;
}

interface LastPromoter {
  mobile: string;
  clientId: string;
  timestamp: number;
}

const MOBILE_HISTORY_TTL = 7200; // 2 hours
const CHANNEL_LAST_MOBILE_TTL = 3600; // 1 hour
const MAX_HISTORY_SIZE = 50;

export class RedisPromotionTracker {
  private static instance: RedisPromotionTracker;

  constructor(private redis: Redis) {}

  static init(redis: Redis): RedisPromotionTracker {
    if (!RedisPromotionTracker.instance) {
      RedisPromotionTracker.instance = new RedisPromotionTracker(redis);
    }
    return RedisPromotionTracker.instance;
  }

  static getInstance(): RedisPromotionTracker {
    if (!RedisPromotionTracker.instance) {
      throw new Error('RedisPromotionTracker not initialized. Call init() first.');
    }
    return RedisPromotionTracker.instance;
  }

  /**
   * Record a successful promotion send.
   * Keyed by MOBILE NUMBER for accurate attribution.
   */
  async recordSend(channelId: string, mobile: string, clientId: string): Promise<void> {
    const data = JSON.stringify({
      channelId,
      mobile,
      clientId,
      timestamp: Date.now(),
    } satisfies SendRecord);

    const mobileKey = `promote:mobile:${mobile}:history`;
    const channelKey = `promote:channel:${channelId}:lastMobile`;

    const pipeline = this.redis.pipeline();
    pipeline.lpush(mobileKey, data);
    pipeline.ltrim(mobileKey, 0, MAX_HISTORY_SIZE - 1);
    pipeline.expire(mobileKey, MOBILE_HISTORY_TTL);
    pipeline.set(
      channelKey,
      JSON.stringify({ mobile, clientId, timestamp: Date.now() } satisfies LastPromoter),
      'EX',
      CHANNEL_LAST_MOBILE_TTL,
    );
    await pipeline.exec();
  }

  /**
   * Get promotion history for a mobile number.
   */
  async getMobileHistory(mobile: string): Promise<SendRecord[]> {
    const key = `promote:mobile:${mobile}:history`;
    const items = await this.redis.lrange(key, 0, -1);
    return items
      .map((i): SendRecord | null => { try { return JSON.parse(i); } catch { return null; } })
      .filter((x): x is SendRecord => x !== null);
  }

  /**
   * Get which mobile last promoted to a channel.
   */
  async getLastPromoter(channelId: string): Promise<LastPromoter | null> {
    const key = `promote:channel:${channelId}:lastMobile`;
    const data = await this.redis.get(key);
    if (!data) return null;
    try { return JSON.parse(data); } catch { return null; }
  }
}

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

import type { RedisLike } from '../../types';
import { normalizeChannelId } from '../utils/channel-id';

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
const CHANNEL_LAST_MOBILE_TTL = 7200; // 2 hours, aligned with attribution window
const MAX_HISTORY_SIZE = 50;

export class RedisPromotionTracker {
  private static instance: RedisPromotionTracker | undefined;

  constructor(private redis: RedisLike) {
    if (!isRedisLike(redis)) {
      throw new Error('RedisPromotionTracker redis client is required');
    }
  }

  static init(redis: RedisLike, options: { replace?: boolean } = {}): RedisPromotionTracker {
    if (!RedisPromotionTracker.instance || shouldReplace(options)) {
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

  static reset(): void {
    RedisPromotionTracker.instance = undefined;
  }

  /**
   * Record a successful promotion send.
   * Keyed by MOBILE NUMBER for accurate attribution.
   */
  async recordSend(channelId: string, mobile: string, clientId: string): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    const safeMobile = normalizeKeyPart(mobile);
    const safeClientId = normalizeKeyPart(clientId);
    if (!safeChannelId || !safeMobile || !safeClientId) return;

    const timestamp = Date.now();
    const data = JSON.stringify({
      channelId: safeChannelId,
      mobile: safeMobile,
      clientId: safeClientId,
      timestamp,
    } satisfies SendRecord);

    const mobileKey = `promote:mobile:${safeMobile}:history`;
    const channelKey = `promote:channel:${safeChannelId}:lastMobile`;

    const pipeline = this.redis.pipeline();
    if (!isRedisPipelineLike(pipeline)) {
      throw new Error('RedisPromotionTracker redis pipeline is required');
    }
    pipeline.lpush(mobileKey, data);
    pipeline.ltrim(mobileKey, 0, MAX_HISTORY_SIZE - 1);
    pipeline.expire(mobileKey, MOBILE_HISTORY_TTL);
    pipeline.set(
      channelKey,
      JSON.stringify({ mobile: safeMobile, clientId: safeClientId, timestamp } satisfies LastPromoter),
      'EX',
      CHANNEL_LAST_MOBILE_TTL,
    );
    const execResult = await pipeline.exec();
    const pipelineError = getPipelineExecError(execResult);
    if (pipelineError) {
      throw new Error(`RedisPromotionTracker redis pipeline exec failed: ${pipelineError}`);
    }
  }

  /**
   * Get promotion history for a mobile number.
   */
  async getMobileHistory(mobile: string): Promise<SendRecord[]> {
    const safeMobile = normalizeKeyPart(mobile);
    if (!safeMobile) return [];
    const key = `promote:mobile:${safeMobile}:history`;
    const items = normalizeRedisList(await this.redis.lrange(key, 0, -1));
    const records: SendRecord[] = [];
    for (const item of items) {
      const record = normalizeSendRecord(parseJson(item));
      if (record) records.push(record);
    }
    return records;
  }

  /**
   * Get which mobile last promoted to a channel.
   */
  async getLastPromoter(channelId: string): Promise<LastPromoter | null> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return null;
    const key = `promote:channel:${safeChannelId}:lastMobile`;
    const data = await this.redis.get(key);
    if (!data) return null;
    const parsed = parseJson(data);
    return normalizeLastPromoter(parsed);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeSendRecord(value: unknown): SendRecord | null {
  if (!isRecord(value)) return null;
  const channelId = normalizeChannelId(value['channelId']);
  const mobile = normalizeKeyPart(value['mobile']);
  const clientId = normalizeKeyPart(value['clientId']);
  const timestamp = value['timestamp'];
  if (!channelId || !mobile || !clientId || !isValidAttributionTimestamp(timestamp, MOBILE_HISTORY_TTL)) return null;
  return { channelId, mobile, clientId, timestamp };
}

function normalizeLastPromoter(value: unknown): LastPromoter | null {
  if (!isRecord(value)) return null;
  const mobile = normalizeKeyPart(value['mobile']);
  const clientId = normalizeKeyPart(value['clientId']);
  const timestamp = value['timestamp'];
  if (!mobile || !clientId || !isValidAttributionTimestamp(timestamp, CHANNEL_LAST_MOBILE_TTL)) return null;
  return { mobile, clientId, timestamp };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidAttributionTimestamp(value: unknown, ttlSeconds: number): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false;
  const ageMs = Date.now() - value;
  return ageMs >= 0 && ageMs <= ttlSeconds * 1000;
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
    && typeof value['lrange'] === 'function'
    && typeof value['pipeline'] === 'function';
}

function isRedisPipelineLike(value: unknown): value is ReturnType<RedisLike['pipeline']> {
  return isRecord(value)
    && typeof value['lpush'] === 'function'
    && typeof value['ltrim'] === 'function'
    && typeof value['expire'] === 'function'
    && typeof value['set'] === 'function'
    && typeof value['exec'] === 'function';
}

function normalizeRedisList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function getPipelineExecError(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const candidate = Array.isArray(item) ? item[0] : item;
    if (!candidate) continue;
    if (candidate instanceof Error) return candidate.message || candidate.name;
    if (typeof candidate === 'string') return candidate;
    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }
  return null;
}

function shouldReplace(options: unknown): boolean {
  return isRecord(options) && options['replace'] === true;
}

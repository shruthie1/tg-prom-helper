/**
 * Conversion Attribution Service — mobile-based ROI via common chats.
 *
 * When tg-aut gets a new user DM, this service attributes the conversion
 * to source channels using:
 * 1. Common chats between buffer account and new user
 * 2. Redis-based promotion history (which mobile last promoted to each channel)
 *
 * Weight decays exponentially — most recent promoted channel gets heaviest weight.
 */

import { ChannelIntelligenceService } from '../channel-intelligence/channel-intelligence-service';
import { RedisPromotionTracker } from '../redis/redis-promotion-tracker';
import { normalizeChannelId } from '../utils/channel-id';

interface AttributionResult {
  channelId: string;
  mobile: string;
  weight: number;
}

export type CommonChatId = string | number | bigint;

export class ConversionAttributionService {
  private static instance: ConversionAttributionService | undefined;

  constructor(
    private intelligenceService: ChannelIntelligenceService,
    private tracker: RedisPromotionTracker,
  ) {
    if (!isIntelligenceServiceLike(intelligenceService)) {
      throw new Error('ConversionAttributionService intelligence service is required');
    }
    if (!isTrackerLike(tracker)) {
      throw new Error('ConversionAttributionService promotion tracker is required');
    }
  }

  static init(
    intelligenceService: ChannelIntelligenceService,
    tracker: RedisPromotionTracker,
    options: { replace?: boolean } = {},
  ): ConversionAttributionService {
    if (!ConversionAttributionService.instance || shouldReplace(options)) {
      ConversionAttributionService.instance = new ConversionAttributionService(
        intelligenceService,
        tracker,
      );
    }
    return ConversionAttributionService.instance;
  }

  static getInstance(): ConversionAttributionService {
    if (!ConversionAttributionService.instance) {
      throw new Error('ConversionAttributionService not initialized.');
    }
    return ConversionAttributionService.instance;
  }

  static reset(): void {
    ConversionAttributionService.instance = undefined;
  }

  /**
   * Attribute a conversion to source channels using common chat IDs.
   *
   * The caller (tg-aut) must provide the common chat IDs obtained via
   * client.invoke(new Api.messages.GetCommonChats({ userId, maxId: 0, limit: 100 }))
   *
   * This keeps the Telegram API call in tg-aut (where the client lives)
   * and keeps this service pure logic.
   *
   * @param commonChatIds - Channel IDs from GetCommonChats
   */
  async attributeConversion(
    commonChatIds: CommonChatId[],
    isPaid: boolean = false,
  ): Promise<{ attributedChannels: AttributionResult[] }> {
    const uniqueChatIds = normalizeCommonChatIds(commonChatIds);
    if (uniqueChatIds.length === 0) return { attributedChannels: [] };
    const shouldRecordPaid = isPaid === true;

    try {
      // For each common chat, check if a promote mobile sent there recently
      const candidates: { channelId: string; mobile: string; clientId: string; timestamp: number }[] = [];
      const seenCandidateChannelIds = new Set<string>();
      const TWO_HOURS = 2 * 3600000;
      const now = Date.now();

      for (const channelId of uniqueChatIds) {
        const candidate = await findLastPromoterCandidate(this.tracker, channelId);
        const ageMs = candidate ? now - candidate.timestamp : Number.NaN;
        if (
          candidate
          && ageMs >= 0
          && ageMs < TWO_HOURS
          && !seenCandidateChannelIds.has(candidate.channelId)
        ) {
          seenCandidateChannelIds.add(candidate.channelId);
          candidates.push(candidate);
        }
      }

      if (candidates.length === 0) return { attributedChannels: [] };

      // Weight by recency: most recent promoted channel gets heaviest weight
      // Exponential decay: weight halves every 15 minutes
      candidates.sort((a, b) => b.timestamp - a.timestamp);

      let totalWeight = 0;
      const weighted = candidates.map(c => {
        const minutesAgo = (now - c.timestamp) / 60000;
        const weight = Math.pow(0.5, minutesAgo / 15);
        totalWeight += weight;
        return { ...c, weight };
      });
      if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
        return { attributedChannels: [] };
      }

      const kept = weighted
        .map((candidate) => ({ ...candidate, initialWeight: candidate.weight / totalWeight }))
        .filter((candidate) => candidate.initialWeight >= 0.05);
      const keptTotalWeight = kept.reduce((sum, candidate) => sum + candidate.weight, 0);
      if (!Number.isFinite(keptTotalWeight) || keptTotalWeight <= 0) {
        return { attributedChannels: [] };
      }

      const attributions: AttributionResult[] = [];

      for (const w of kept) {
        const normalized = w.weight / keptTotalWeight;

        attributions.push({
          channelId: w.channelId,
          mobile: w.mobile,
          weight: normalized,
        });

        try {
          // Increment fractional conversion on the channel.
          await this.intelligenceService.recordConversion(w.channelId, normalized);
          if (shouldRecordPaid) {
            await this.intelligenceService.recordPaidConversion(w.channelId, normalized);
          }
        } catch {
          // Attribution discovery should still return even when analytics persistence is transiently down.
        }
      }

      return { attributedChannels: attributions };
    } catch {
      return { attributedChannels: [] };
    }
  }
}

function normalizeLastPromoter(value: unknown): { mobile: string; clientId: string; timestamp: number } | null {
  if (!isRecord(value)) return null;
  const mobile = normalizeLabel(value['mobile']);
  const clientId = normalizeLabel(value['clientId']);
  const timestamp = value['timestamp'];
  if (!mobile || !clientId || typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  return { mobile, clientId, timestamp };
}

function normalizeCommonChatIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map(normalizeCommonChatId)
    .filter((item) => item.length > 0);
  return Array.from(new Set(ids));
}

function normalizeCommonChatId(value: unknown): string {
  if (typeof value === 'string') return normalizeChannelId(value) ?? '';
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? normalizeChannelId(String(value)) ?? '' : '';
  }
  if (typeof value === 'bigint') return normalizeChannelId(value.toString()) ?? '';
  return '';
}

async function findLastPromoterCandidate(
  tracker: RedisPromotionTracker,
  channelId: string,
): Promise<{ channelId: string; mobile: string; clientId: string; timestamp: number } | null> {
  let best: { channelId: string; mobile: string; clientId: string; timestamp: number } | null = null;
  for (const lookupId of getCommonChatLookupIds(channelId)) {
    try {
      const lastPromoter = normalizeLastPromoter(await tracker.getLastPromoter(lookupId));
      if (!lastPromoter) continue;
      const canonicalChannelId = normalizeChannelId(lookupId);
      if (!canonicalChannelId) continue;
      const candidate = { channelId: canonicalChannelId, ...lastPromoter };
      if (!best || candidate.timestamp > best.timestamp) {
        best = candidate;
      }
    } catch {
      continue;
    }
  }
  return best;
}

function getCommonChatLookupIds(channelId: string): string[] {
  const normalized = channelId.trim();
  if (!normalized) return [];

  const variants = [normalized];
  if (normalized.startsWith('-100')) {
    variants.push(normalized.slice(4));
  } else if (normalized.startsWith('-')) {
    const unsigned = normalized.slice(1);
    variants.push(unsigned, `-100${unsigned}`);
  } else if (/^\d+$/.test(normalized)) {
    variants.push(`-100${normalized}`);
  }

  return Array.from(new Set(variants.filter((value) => value.length > 0)));
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntelligenceServiceLike(value: unknown): value is ChannelIntelligenceService {
  return isRecord(value)
    && typeof value['recordConversion'] === 'function'
    && typeof value['recordPaidConversion'] === 'function';
}

function isTrackerLike(value: unknown): value is RedisPromotionTracker {
  return isRecord(value) && typeof value['getLastPromoter'] === 'function';
}

function shouldReplace(options: unknown): boolean {
  return isRecord(options) && options['replace'] === true;
}

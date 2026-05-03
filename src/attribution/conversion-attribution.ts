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

import type { Redis } from 'ioredis';
import { ChannelIntelligenceService } from '../channel-intelligence/channel-intelligence-service';
import { RedisPromotionTracker } from '../redis/redis-promotion-tracker';

interface AttributionResult {
  channelId: string;
  mobile: string;
  weight: number;
}

export class ConversionAttributionService {
  private static instance: ConversionAttributionService;

  constructor(
    private intelligenceService: ChannelIntelligenceService,
    private tracker: RedisPromotionTracker,
  ) {}

  static init(
    intelligenceService: ChannelIntelligenceService,
    tracker: RedisPromotionTracker,
  ): ConversionAttributionService {
    if (!ConversionAttributionService.instance) {
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
    commonChatIds: string[],
    isPaid: boolean = false,
  ): Promise<{ attributedChannels: AttributionResult[] }> {
    if (commonChatIds.length === 0) return { attributedChannels: [] };

    try {
      // For each common chat, check if a promote mobile sent there recently
      const candidates: { channelId: string; mobile: string; clientId: string; timestamp: number }[] = [];
      const TWO_HOURS = 2 * 3600000;

      for (const channelId of commonChatIds) {
        const lastPromoter = await this.tracker.getLastPromoter(channelId);
        if (lastPromoter && Date.now() - lastPromoter.timestamp < TWO_HOURS) {
          candidates.push({ channelId, ...lastPromoter });
        }
      }

      if (candidates.length === 0) return { attributedChannels: [] };

      // Weight by recency: most recent promoted channel gets heaviest weight
      // Exponential decay: weight halves every 15 minutes
      candidates.sort((a, b) => b.timestamp - a.timestamp);

      let totalWeight = 0;
      const weighted = candidates.map(c => {
        const minutesAgo = (Date.now() - c.timestamp) / 60000;
        const weight = Math.pow(0.5, minutesAgo / 15);
        totalWeight += weight;
        return { ...c, weight };
      });

      const attributions: AttributionResult[] = [];

      for (const w of weighted) {
        const normalized = w.weight / totalWeight;
        if (normalized < 0.05) continue;

        attributions.push({
          channelId: w.channelId,
          mobile: w.mobile,
          weight: normalized,
        });

        // Increment fractional conversion on the channel
        await this.intelligenceService.recordConversion(w.channelId, normalized);
        if (isPaid) {
          await this.intelligenceService.recordPaidConversion(w.channelId, normalized);
        }
      }

      return { attributedChannels: attributions };
    } catch {
      return { attributedChannels: [] };
    }
  }
}

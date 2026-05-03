/**
 * Standalone expected value scoring function.
 *
 * Can be used for batch computation in CommonTgService analytics
 * without needing the full ChannelIntelligenceService.
 */

import type { ChannelIntelligenceDocument } from '../channel-intelligence/channel-intelligence.types';
import type { ChannelPercentiles } from '../types';

/**
 * Compute expected value for a channel intelligence document.
 * Same formula as ChannelIntelligenceService.recomputeExpectedValue().
 *
 * @param doc - The channel intelligence document
 * @param percentiles - Optional percentile data for conversion/saturation modifiers
 * @param getPercentileRank - Optional function to compute percentile rank
 */
export function computeExpectedValue(
  doc: ChannelIntelligenceDocument,
  percentiles?: ChannelPercentiles | null,
  getPercentileRank?: (value: number, metric: keyof ChannelPercentiles) => number,
): number {
  // Best arm posterior mean
  const armEVs = Object.values(doc.strategies).map(arm => {
    const total = arm.s + arm.f;
    return total === 0 ? 0.5 : arm.s / total;
  });
  const bestArmEV = Math.max(...armEVs);

  // Followup modifier
  const fuBonus = doc.followupTotal < 5 ? 0 : (doc.followupSuccessRate - 0.5) * 0.2;

  // Automod penalty
  const totalDel = doc.deletionTiming.automod + doc.deletionTiming.bot
    + doc.deletionTiming.human + doc.deletionTiming.late;
  const automodPenalty = totalDel === 0 ? 0 : (doc.deletionTiming.automod / totalDel) * 0.3;

  // Online bonus
  const onlineAge = Date.now() - doc.onlineTrend.lastSampled;
  const onlineBonus = (onlineAge < 30 * 60_000 && doc.onlineTrend.ewma > 50)
    ? Math.min(0.1, doc.onlineTrend.ewma / 1000) : 0;

  // View engagement bonus
  const viewAge = Date.now() - doc.viewEngagement.lastChecked;
  const viewBonus = (viewAge < 60 * 60_000 && doc.viewEngagement.checksCount >= 3)
    ? Math.min(0.1, (doc.viewEngagement.ewmaRatio - 0.3) * 0.15) : 0;

  // Error penalty
  const errorPenalty = Math.min(0.4, (doc.errors.consecutiveErrors || 0) * 0.08);

  // Percentile-based modifiers
  let conversionBonus = 0;
  let saturationPenalty = 0;

  if (percentiles && getPercentileRank) {
    const conversionRank = getPercentileRank(doc.conversions || 0, 'conversionRate');
    conversionBonus = conversionRank >= 0.75 ? 0.15 : conversionRank >= 0.50 ? 0.08 : 0;

    const saturationRank = getPercentileRank(doc.saturationRate || 0, 'saturationRate');
    saturationPenalty = saturationRank >= 0.90 ? 0.25
      : saturationRank >= 0.75 ? 0.12
      : 0;
  }

  // Channel category fitness
  const categoryBonus = doc.channelCategory === 'high_intent' ? 0.10
    : doc.channelCategory === 'social_chat' ? 0.03
    : doc.channelCategory === 'off_topic' ? -0.15
    : 0;

  return Math.max(0.01, Math.min(0.99,
    bestArmEV + fuBonus + onlineBonus + viewBonus + conversionBonus + categoryBonus
    - automodPenalty - errorPenalty - saturationPenalty
  ));
}

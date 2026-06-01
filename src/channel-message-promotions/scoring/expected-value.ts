/**
 * Standalone expected value scoring function.
 *
 * Can be used for batch computation in CommonTgService analytics
 * without needing the full ChannelIntelligenceService.
 */

import type { ChannelIntelligenceDocument } from '../channel-intelligence/channel-intelligence.types';
import type { ChannelPercentiles } from '../../types';
import { PROMOTION_MESSAGE_STRATEGIES } from '../message-strategy';

function safeNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeRate(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function safeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

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
  const safeDoc = asRecord(doc);
  const now = Date.now();
  // Best arm posterior mean
  const strategyRecord = asRecord(safeDoc['strategies']);
  const armEVs = PROMOTION_MESSAGE_STRATEGIES.map(strategy => {
    const armRecord = asRecord(strategyRecord[strategy]);
    const successes = safeNonNegative(armRecord['s']);
    const failures = safeNonNegative(armRecord['f']);
    const total = successes + failures;
    return total === 0 ? 0.5 : successes / total;
  });
  const bestArmEV = armEVs.length > 0 ? Math.max(...armEVs) : 0.5;

  // Followup modifier
  const followupTotal = safeNonNegative(safeDoc['followupTotal']);
  const followupSuccessRate = safeRate(safeDoc['followupSuccessRate'], 0.5);
  const fuBonus = followupTotal < 5 ? 0 : (followupSuccessRate - 0.5) * 0.2;

  // Automod penalty
  const deletionTiming = asRecord(safeDoc['deletionTiming']);
  const automodDeletions = safeNonNegative(deletionTiming['automod']);
  const totalDel = automodDeletions + safeNonNegative(deletionTiming['bot'])
    + safeNonNegative(deletionTiming['human']) + safeNonNegative(deletionTiming['late']);
  const automodPenalty = totalDel === 0 ? 0 : (automodDeletions / totalDel) * 0.3;

  // Online bonus
  const onlineTrend = asRecord(safeDoc['onlineTrend']);
  const onlineAge = safeAgeMs(onlineTrend['lastSampled'], now);
  const onlineEwma = safeNonNegative(onlineTrend['ewma']);
  const onlineBonus = (onlineAge < 30 * 60_000 && onlineEwma > 50)
    ? Math.min(0.1, onlineEwma / 1000) : 0;

  // View engagement bonus
  const viewEngagement = asRecord(safeDoc['viewEngagement']);
  const viewAge = safeAgeMs(viewEngagement['lastChecked'], now);
  const viewBonus = (viewAge < 60 * 60_000 && safeNonNegative(viewEngagement['checksCount']) >= 3)
    ? Math.max(0, Math.min(0.1, (safeRate(viewEngagement['ewmaRatio'], 0) - 0.3) * 0.15)) : 0;

  // Error penalty
  const errors = asRecord(safeDoc['errors']);
  const errorPenalty = Math.min(0.4, safeNonNegative(errors['consecutiveErrors']) * 0.08);

  // Percentile-based modifiers
  let conversionBonus = 0;
  let saturationPenalty = 0;

  if (percentiles && getPercentileRank) {
    const weightedConversions = safeNonNegative(safeDoc['conversions'])
      + safeNonNegative(safeDoc['paidConversions']) * 2;
    const conversionRate = weightedConversions / Math.max(1, safeNonNegative(safeDoc['totalSendsToChannel']));
    const conversionRank = safeRank(getPercentileRank, conversionRate, 'conversionRate');
    conversionBonus = conversionRank >= 0.75 ? 0.15 : conversionRank >= 0.50 ? 0.08 : 0;

    const saturationRank = safeRank(getPercentileRank, safeNonNegative(safeDoc['saturationRate']), 'saturationRate');
    saturationPenalty = saturationRank >= 0.90 ? 0.25
      : saturationRank >= 0.75 ? 0.12
      : 0;
  }

  // Channel category fitness
  const channelCategory = typeof safeDoc['channelCategory'] === 'string' ? safeDoc['channelCategory'] : 'unclassified';
  const categoryBonus = channelCategory === 'high_intent' ? 0.10
    : channelCategory === 'social_chat' ? 0.03
    : channelCategory === 'off_topic' ? -0.15
    : 0;

  return Math.max(0.01, Math.min(0.99,
    bestArmEV + fuBonus + onlineBonus + viewBonus + conversionBonus + categoryBonus
    - automodPenalty - errorPenalty - saturationPenalty
  ));
}

function safeRank(
  getPercentileRank: (value: number, metric: keyof ChannelPercentiles) => number,
  value: number,
  metric: keyof ChannelPercentiles,
): number {
  try {
    const rank = getPercentileRank(value, metric);
    return Number.isFinite(rank) ? Math.max(0, Math.min(1, rank)) : 0.5;
  } catch {
    return 0.5;
  }
}

function safeAgeMs(value: unknown, now: number): number {
  const timestamp = safeTimestamp(value);
  if (timestamp <= 0 || timestamp > now) return Number.POSITIVE_INFINITY;
  return now - timestamp;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

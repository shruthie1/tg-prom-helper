import type {
  ChannelClassificationSnapshot,
  ChannelEligibilityInput,
  ChannelEligibilityResult,
} from './policy.types';
import { evaluateChannelPromotionHealth } from '../../channel-state';
import { safeNonNegative, safeUnitRandom } from './policy-number-utils';

export function evaluatePromotionChannelEligibility(
  input: ChannelEligibilityInput,
): ChannelEligibilityResult {
  const safeInput = isRecord(input) ? input as Partial<ChannelEligibilityInput> : {};
  if (!isRecord(safeInput.channel)) {
    return { eligible: false, reason: 'Invalid channel' };
  }
  const {
    channel,
    scoringEnabled,
    now = Date.now(),
    previousResult,
    recentlyQueued = false,
    recentlyPromotedByOtherAccount = false,
    percentiles,
    classification,
    random = Math.random,
  } = safeInput;

  const safeNow = safeTimestamp(now, Date.now());
  const participantsCount = safeNonNegative(channel.participantsCount);
  const deletedCount = safeNonNegative(channel.deletedCount);
  const successMsgCount = safeNonNegative(channel.successMsgCount);
  const failureMsgCount = safeNonNegative(channel.failureMsgCount);

  if (recentlyQueued === true) return { eligible: false, reason: 'Recently promoted (in queue)' };
  if (recentlyPromotedByOtherAccount === true) {
    return { eligible: false, reason: 'Recently promoted by another account' };
  }
  const health = evaluateChannelPromotionHealth({ ...channel, now: safeNow });
  if (!health.promotable) return { eligible: false, reason: health.reason };

  const previousFailure = previousResult && !previousResult.success ? previousResult : null;
  const previousFailureTimestamp = previousFailure
    ? safeTimestamp(previousFailure.lastCheckTimestamp, 0)
    : 0;
  if (
    previousFailureTimestamp > 0
    && previousFailureTimestamp <= safeNow
    && previousFailureTimestamp > safeNow - 24 * 60 * 60 * 1000
  ) {
    return { eligible: false, reason: `Recent failure (${previousFailure?.errorMessage || 'Unknown error'})` };
  }

  if (scoringEnabled === true && percentiles) {
    const totalAttempts = successMsgCount + failureMsgCount;
    if (totalAttempts >= 5) {
      const successRate = successMsgCount / totalAttempts;
      const deleteRate = deletedCount / Math.max(1, successMsgCount);

      if (safePercentileRank(percentiles, successRate, 'successRate') < 0.10 && totalAttempts > 20) {
        return { eligible: false, reason: `Success rate ${(successRate * 100).toFixed(1)}% in bottom 10%` };
      }

      const deleteRank = safePercentileRank(percentiles, deleteRate, 'deleteRate');
      if (deleteRank >= 0.90 && safeUnitRandom(random) > 0.1) return { eligible: false, reason: 'Delete rate p90+' };
      if (deleteRank >= 0.75 && safeUnitRandom(random) > 0.3) return { eligible: false, reason: 'Delete rate p75-p90' };
    }

    const participantRank = safePercentileRank(percentiles, participantsCount, 'participantsCount');
    if (participantRank < 0.10) {
      return { eligible: false, reason: `Participants in bottom 10% (${participantsCount})` };
    }

    const classificationConfidence = classification?.confidence ?? 0;
    if (isConfidentOffTopic(classification) && safeUnitRandom(random) > 0.05) {
      return { eligible: false, reason: `Off-topic (${classificationConfidence.toFixed(2)} confidence)` };
    }
  }

  return { eligible: true, reason: null };
}

function isConfidentOffTopic(classification?: ChannelClassificationSnapshot | null): boolean {
  return classification?.category === 'off_topic' && safeConfidence(classification.confidence) > 0.6;
}

function safeTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safePercentileRank(
  percentiles: { getPercentileRankSync(value: number, metric: string): number },
  value: number,
  metric: string,
): number {
  try {
    const rank = percentiles.getPercentileRankSync(value, metric);
    return Number.isFinite(rank) ? Math.max(0, Math.min(1, rank)) : 0.5;
  } catch {
    return 0.5;
  }
}

function safeConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

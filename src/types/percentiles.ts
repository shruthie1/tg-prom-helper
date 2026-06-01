/**
 * Shared interfaces for the promotion intelligence system.
 * Used by promote-clients-local, tg-aut-local, and CommonTgService-local.
 */

export interface PercentileBuckets {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** Number of channels that contributed to this metric */
  count: number;
}

export interface ChannelPercentiles {
  successRate: PercentileBuckets;
  deleteRate: PercentileBuckets;
  participantsCount: PercentileBuckets;
  deletedCount: PercentileBuckets;
  /** Total promotion attempts (success + failure) per channel */
  messageVolume: PercentileBuckets;
  followupSurvivalRate: PercentileBuckets;
  conversionRate: PercentileBuckets;
  /** totalSendsToChannel / participantsCount — diminishing returns signal */
  saturationRate: PercentileBuckets;
}

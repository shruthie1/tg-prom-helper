// Channel Intelligence
export {
  ChannelIntelligenceService,
  PercentileEngine,
  ChannelClassifier,
  type ClassificationResult,
  type LifecycleStage,
  type MessageStrategy,
  type StrategyArm,
  type DeletionTimingBuckets,
  type OnlineTrend,
  type ViewEngagement,
  type ErrorSummary,
  type ChannelCategory,
  type ChannelIntelligenceDocument,
  ALL_STRATEGIES,
  createDefaultStrategies,
  createDefaultIntelligence,
} from './channel-intelligence';

// Message Strategy
export {
  DiscountedThompsonSampling,
  betaSample,
  selectChannelStrategy,
  COLD_START_THRESHOLD,
} from './message-strategy';

// Scoring
export { computeExpectedValue } from './scoring';

// Redis
export { RedisChannelLock, RedisPromotionTracker } from './redis';

// Attribution
export { ConversionAttributionService } from './attribution';

// Types
export type { ChannelPercentiles, PercentileBuckets } from './types';

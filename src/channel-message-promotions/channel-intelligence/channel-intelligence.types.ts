/**
 * Channel Intelligence type definitions.
 * Evolved from tg-aut's types/channel-intelligence.ts.
 *
 * Changes from tg-aut version:
 * - Removed HourlyBuckets (no time-of-day optimization)
 * - Added saturation tracking (totalSendsToChannel, saturationRate)
 * - Added ROI fields (conversions, paidConversions)
 * - Added channel classification (channelCategory, promotionFitScore)
 */

// --- Lifecycle ---

export type LifecycleStage = 'new' | 'learning' | 'optimized' | 'hostile';

// --- Message strategies ---

export type MessageStrategy =
  | 'ai_contextual'
  | 'markov_chain'
  | 'natural_template'
  | 'question_doubt'
  | 'curiosity_gap'
  | 'legacy';

export const ALL_STRATEGIES: MessageStrategy[] = [
  'ai_contextual', 'markov_chain', 'natural_template',
  'question_doubt', 'curiosity_gap', 'legacy',
];

// --- Sub-document types ---

export interface StrategyArm {
  /** Discounted success count (float) */
  s: number;
  /** Discounted failure count (float) */
  f: number;
  /** Total pulls (undiscounted integer) */
  n: number;
}

export interface DeletionTimingBuckets {
  /** Deleted within 30s (automod signal) */
  automod: number;
  /** Deleted 30s–2min (bot admin) */
  bot: number;
  /** Deleted 2–10min (human admin) */
  human: number;
  /** Deleted after 10min */
  late: number;
}

export interface OnlineTrend {
  /** Exponentially-weighted moving average of online count */
  ewma: number;
  /** Unix ms of last sample */
  lastSampled: number;
  /** Total samples taken */
  sampleCount: number;
}

export interface ViewEngagement {
  /** EWMA of views/participants ratio */
  ewmaRatio: number;
  /** Unix ms of last check */
  lastChecked: number;
  /** Total checks performed */
  checksCount: number;
}

export interface ErrorSummary {
  SLOWMODE_WAIT?: number;
  PEER_FLOOD?: number;
  FLOOD_WAIT?: number;
  CHANNEL_RESTRICTED?: number;
  TRANSIENT?: number;
  lastErrorType?: string;
  lastErrorAt?: number;
  consecutiveErrors?: number;
}

// --- Channel classification ---

/** Data-driven categories — learned from performance, not hardcoded keywords */
export type ChannelCategory =
  | 'high_intent'       // dating, adult, relationship — strong match
  | 'social_chat'       // general chatting groups — moderate match
  | 'regional_social'   // language/region-specific social — moderate match
  | 'off_topic'         // crypto, gaming, news, education — poor match
  | 'unclassified';     // not enough data yet

// --- Main document ---

export interface ChannelIntelligenceDocument {
  channelId: string;

  // Lifecycle
  stage: LifecycleStage;
  stageUpdatedAt: number;
  firstSeenAt: number;

  // Cached classification
  topic: string;
  topicConfidence: number;
  language: string;
  languageConfidence: number;
  profileUpdatedAt: number;

  // Per-strategy Thompson Sampling arms
  strategies: Record<MessageStrategy, StrategyArm>;

  // Followup intelligence
  followupSuccessRate: number;
  followupSuccessCount: number;
  followupTotal: number;

  // Deletion timing
  deletionTiming: DeletionTimingBuckets;

  // GramJS signals
  onlineTrend: OnlineTrend;
  viewEngagement: ViewEngagement;

  // Error intelligence
  errors: ErrorSummary;

  // Cooldown
  lastPromotedAt: number;
  cooldownUntil: number;

  // Scoring cache
  expectedValue: number;
  scoreUpdatedAt: number;

  // Saturation tracking
  /** Total promotion messages sent (success + follow-up) */
  totalSendsToChannel: number;
  /** Cached: totalSendsToChannel / participantsCount */
  saturationRate: number;

  // ROI
  /** Fractional attribution count */
  conversions: number;
  /** Users who paid */
  paidConversions: number;
  conversionUpdatedAt: number;

  // Channel classification
  channelCategory: ChannelCategory;
  categoryConfidence: number;
  categoryUpdatedAt: number;
  /** 0-1 how well this channel converts for our use case */
  promotionFitScore: number;

  updatedAt: Date;
}

// --- Defaults factory ---

const EMPTY_ARM: StrategyArm = { s: 0, f: 0, n: 0 };

export function createDefaultStrategies(): Record<MessageStrategy, StrategyArm> {
  return {
    ai_contextual: { ...EMPTY_ARM },
    markov_chain: { ...EMPTY_ARM },
    natural_template: { ...EMPTY_ARM },
    question_doubt: { ...EMPTY_ARM },
    curiosity_gap: { ...EMPTY_ARM },
    legacy: { ...EMPTY_ARM },
  };
}

export function createDefaultIntelligence(channelId: string, topic: string = 'general_chat'): ChannelIntelligenceDocument {
  const now = Date.now();
  return {
    channelId,
    stage: 'new',
    stageUpdatedAt: now,
    firstSeenAt: now,
    topic,
    topicConfidence: 0,
    language: 'english',
    languageConfidence: 0,
    profileUpdatedAt: 0,
    strategies: createDefaultStrategies(),
    followupSuccessRate: 0.5,
    followupSuccessCount: 0,
    followupTotal: 0,
    deletionTiming: { automod: 0, bot: 0, human: 0, late: 0 },
    onlineTrend: { ewma: 0, lastSampled: 0, sampleCount: 0 },
    viewEngagement: { ewmaRatio: 0, lastChecked: 0, checksCount: 0 },
    errors: { consecutiveErrors: 0 },
    lastPromotedAt: 0,
    cooldownUntil: 0,
    expectedValue: 0.5,
    scoreUpdatedAt: now,
    totalSendsToChannel: 0,
    saturationRate: 0,
    conversions: 0,
    paidConversions: 0,
    conversionUpdatedAt: 0,
    channelCategory: 'unclassified',
    categoryConfidence: 0,
    categoryUpdatedAt: 0,
    promotionFitScore: 0.25,
    updatedAt: new Date(),
  };
}

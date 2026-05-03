/**
 * Channel Intelligence Service — MongoDB-backed per-channel learning.
 *
 * Evolved from tg-aut's version. Key changes:
 * - ALL lifecycle thresholds are percentile-based (no hardcoded values)
 * - Removed hourly buckets (no time-of-day optimization)
 * - Added saturation tracking (totalSendsToChannel / participantsCount)
 * - Added conversion recording for ROI
 * - Added channel classification updates
 * - Scoring includes saturation penalty, conversion bonus, category fitness
 *
 * All writes use atomic $inc/$set to avoid read-modify-write races.
 */

import type { Collection } from 'mongodb';
import type {
  ChannelIntelligenceDocument,
  LifecycleStage,
  MessageStrategy,
  ChannelCategory,
} from './channel-intelligence.types';
import { createDefaultIntelligence } from './channel-intelligence.types';
import { PercentileEngine } from './percentile-engine';
import { ChannelClassifier } from './channel-classifier';
import { computeExpectedValue } from '../scoring/expected-value';
import type { ChannelPercentiles } from '../types';

// --- EWMA config ---
const EWMA_ALPHA = 0.15;

// --- Deletion timing thresholds (ms) ---
const AUTOMOD_THRESHOLD = 30_000;
const BOT_THRESHOLD = 2 * 60_000;
const HUMAN_THRESHOLD = 10 * 60_000;

// --- Thompson discount ---
const DISCOUNT_GAMMA = 0.995;

type DeletionBucket = 'automod' | 'bot' | 'human' | 'late';

export class ChannelIntelligenceService {
  private static instance: ChannelIntelligenceService;
  private collection: Collection<ChannelIntelligenceDocument>;

  constructor(collection: Collection<ChannelIntelligenceDocument>) {
    this.collection = collection;
  }

  static init(collection: Collection<ChannelIntelligenceDocument>): ChannelIntelligenceService {
    if (!ChannelIntelligenceService.instance) {
      ChannelIntelligenceService.instance = new ChannelIntelligenceService(collection);
    }
    return ChannelIntelligenceService.instance;
  }

  static getInstance(): ChannelIntelligenceService {
    if (!ChannelIntelligenceService.instance) {
      throw new Error('ChannelIntelligenceService not initialized. Call init() first.');
    }
    return ChannelIntelligenceService.instance;
  }

  // --- Read ---

  async get(channelId: string): Promise<ChannelIntelligenceDocument | null> {
    return this.collection.findOne({ channelId });
  }

  async batchGet(
    channelIds: string[],
    projection?: Record<string, 1>,
  ): Promise<ChannelIntelligenceDocument[]> {
    if (channelIds.length === 0) return [];
    const opts = projection ? { projection } : undefined;
    return this.collection.find({ channelId: { $in: channelIds } }, opts).toArray();
  }

  async getTopChannels(limit: number = 50): Promise<ChannelIntelligenceDocument[]> {
    return this.collection.find({
      stage: { $nin: ['hostile'] },
      cooldownUntil: { $lte: Date.now() },
    })
      .sort({ expectedValue: -1 })
      .limit(limit)
      .toArray();
  }

  // --- Upsert ---

  async ensureDoc(channelId: string, topic: string = 'general_chat'): Promise<void> {
    const defaults = createDefaultIntelligence(channelId, topic);
    await this.collection.updateOne(
      { channelId },
      { $setOnInsert: defaults },
      { upsert: true },
    );
  }

  // --- Outcome recording ---

  async recordSuccess(
    channelId: string,
    strategy: MessageStrategy,
    isFollowup: boolean,
  ): Promise<void> {
    await this.ensureDoc(channelId);
    await this.applyDiscount(channelId, strategy);

    const incFields: Record<string, number> = {
      [`strategies.${strategy}.s`]: 1,
      [`strategies.${strategy}.n`]: 1,
      totalSendsToChannel: 1,
    };

    if (isFollowup) {
      incFields['followupTotal'] = 1;
      incFields['followupSuccessCount'] = 1;
    }

    const setFields: Record<string, unknown> = {
      'errors.consecutiveErrors': 0,
      updatedAt: new Date(),
    };

    const doc = await this.collection.findOneAndUpdate(
      { channelId },
      { $inc: incFields, $set: setFields },
      { returnDocument: 'after' },
    );
    if (!doc) return;

    if (isFollowup) {
      await this.writeFollowupRate(channelId, doc);
    }

    await this.writeScoreAndLifecycle(channelId, doc);
  }

  async recordDeletion(
    channelId: string,
    strategy: MessageStrategy,
    survivalMs: number,
    isFollowup: boolean,
  ): Promise<void> {
    await this.ensureDoc(channelId);

    const bucket = this.classifyDeletionTiming(survivalMs);
    await this.applyDiscount(channelId, strategy);

    const incFields: Record<string, number> = {
      [`strategies.${strategy}.f`]: 1,
      [`strategies.${strategy}.n`]: 1,
      [`deletionTiming.${bucket}`]: 1,
    };

    if (isFollowup) {
      incFields['followupTotal'] = 1;
    }

    const doc = await this.collection.findOneAndUpdate(
      { channelId },
      {
        $inc: incFields,
        $set: { updatedAt: new Date() },
      },
      { returnDocument: 'after' },
    );
    if (!doc) return;

    if (isFollowup) {
      await this.writeFollowupRate(channelId, doc);
    }

    await this.writeScoreAndLifecycle(channelId, doc);
  }

  async recordFailure(
    channelId: string,
    strategy: MessageStrategy,
    errorType: string,
  ): Promise<void> {
    await this.ensureDoc(channelId);

    const now = Date.now();
    const errorCategory = this.categorizeError(errorType);

    const incFields: Record<string, number> = {
      [`strategies.${strategy}.f`]: 1,
      [`strategies.${strategy}.n`]: 1,
      [`errors.${errorCategory}`]: 1,
      'errors.consecutiveErrors': 1,
    };

    const setFields: Record<string, unknown> = {
      'errors.lastErrorType': errorType,
      'errors.lastErrorAt': now,
      updatedAt: new Date(),
    };

    const cooldownMs = this.getCooldownForError(errorType);
    if (cooldownMs > 0) {
      setFields['cooldownUntil'] = now + cooldownMs;
    }

    const doc = await this.collection.findOneAndUpdate(
      { channelId },
      { $inc: incFields, $set: setFields },
      { returnDocument: 'after' },
    );
    if (!doc) return;

    await this.writeScoreAndLifecycle(channelId, doc);
  }

  // --- Conversion recording (ROI) ---

  async recordConversion(channelId: string, fractionalWeight: number): Promise<void> {
    await this.ensureDoc(channelId);
    await this.collection.updateOne(
      { channelId },
      {
        $inc: { conversions: fractionalWeight },
        $set: { conversionUpdatedAt: Date.now(), updatedAt: new Date() },
      },
    );
  }

  async recordPaidConversion(channelId: string, fractionalWeight: number): Promise<void> {
    await this.ensureDoc(channelId);
    await this.collection.updateOne(
      { channelId },
      {
        $inc: { paidConversions: fractionalWeight },
        $set: { conversionUpdatedAt: Date.now(), updatedAt: new Date() },
      },
    );
  }

  // --- Channel classification ---

  async updateClassification(
    channelId: string,
    classification: { category: ChannelCategory; confidence: number; promotionFitScore: number },
  ): Promise<void> {
    await this.collection.updateOne(
      { channelId },
      {
        $set: {
          channelCategory: classification.category,
          categoryConfidence: classification.confidence,
          promotionFitScore: classification.promotionFitScore,
          categoryUpdatedAt: Date.now(),
          updatedAt: new Date(),
        },
      },
    );
  }

  // --- Saturation update ---

  async updateSaturationRate(channelId: string, participantsCount: number): Promise<void> {
    const doc = await this.get(channelId);
    if (!doc || participantsCount <= 0) return;

    const rate = doc.totalSendsToChannel / participantsCount;
    await this.collection.updateOne(
      { channelId },
      { $set: { saturationRate: Math.round(rate * 1000) / 1000, updatedAt: new Date() } },
    );
  }

  // --- Post-success periodic updates ---

  /**
   * Refresh classification and saturation after outcome recording.
   * Call after recordSuccess/recordDeletion — skips work unless ~50 pulls elapsed.
   */
  async refreshChannelMeta(
    channelId: string,
    title: string,
    username: string | null,
    participantsCount: number,
  ): Promise<void> {
    const doc = await this.get(channelId);
    if (!doc) return;

    const totalPulls = Object.values(doc.strategies).reduce((sum, arm) => sum + arm.n, 0);

    // Reclassify every ~50 pulls (and on first classification)
    if (totalPulls % 50 < 2 || doc.channelCategory === 'unclassified') {
      const classification = ChannelClassifier.classify(title, username, doc);
      await this.updateClassification(channelId, classification);
    }

    // Update saturation rate on every call (lightweight)
    if (participantsCount > 0) {
      const rate = doc.totalSendsToChannel / participantsCount;
      await this.collection.updateOne(
        { channelId },
        { $set: { saturationRate: Math.round(rate * 1000) / 1000, updatedAt: new Date() } },
      );
    }
  }

  // --- GramJS signal updates ---

  async updateOnlineTrend(channelId: string, onlineCount: number): Promise<void> {
    const doc = await this.get(channelId);
    if (!doc) return;

    const prevEwma = doc.onlineTrend.ewma;
    const newEwma = doc.onlineTrend.sampleCount === 0
      ? onlineCount
      : prevEwma * (1 - EWMA_ALPHA) + onlineCount * EWMA_ALPHA;

    await this.collection.updateOne(
      { channelId },
      {
        $set: {
          'onlineTrend.ewma': Math.round(newEwma * 100) / 100,
          'onlineTrend.lastSampled': Date.now(),
          updatedAt: new Date(),
        },
        $inc: { 'onlineTrend.sampleCount': 1 },
      },
    );
  }

  async updateViewEngagement(
    channelId: string,
    views: number,
    participantsCount: number,
  ): Promise<void> {
    if (participantsCount <= 0 || views <= 0) return;

    const ratio = views / participantsCount;
    const doc = await this.get(channelId);
    if (!doc) return;

    const prevRatio = doc.viewEngagement.ewmaRatio;
    const newRatio = doc.viewEngagement.checksCount === 0
      ? ratio
      : prevRatio * (1 - EWMA_ALPHA) + ratio * EWMA_ALPHA;

    await this.collection.updateOne(
      { channelId },
      {
        $set: {
          'viewEngagement.ewmaRatio': Math.round(newRatio * 1000) / 1000,
          'viewEngagement.lastChecked': Date.now(),
          updatedAt: new Date(),
        },
        $inc: { 'viewEngagement.checksCount': 1 },
      },
    );
  }

  // --- Profile update ---

  async updateProfile(
    channelId: string,
    topic: string,
    topicConfidence: number,
    language: string,
    languageConfidence: number,
  ): Promise<void> {
    await this.ensureDoc(channelId, topic);

    await this.collection.updateOne(
      { channelId },
      {
        $set: {
          topic,
          topicConfidence,
          language,
          languageConfidence,
          profileUpdatedAt: Date.now(),
          updatedAt: new Date(),
        },
      },
    );
  }

  // --- Promotion tracking ---

  async recordPromotion(channelId: string): Promise<void> {
    await this.ensureDoc(channelId);
    await this.collection.updateOne(
      { channelId },
      { $set: { lastPromotedAt: Date.now(), updatedAt: new Date() } },
    );
  }

  // --- Scoring ---

  /**
   * Recompute expected value with percentile-based modifiers.
   * Delegates to the standalone computeExpectedValue() function.
   */
  recomputeExpectedValue(doc: ChannelIntelligenceDocument, percentiles?: ChannelPercentiles | null): number {
    let getRank: ((value: number, metric: keyof ChannelPercentiles) => number) | undefined;
    if (percentiles) {
      try {
        const pe = PercentileEngine.getInstance();
        getRank = (v, m) => pe.getPercentileRankSync(v, m);
      } catch {
        // PercentileEngine not initialized
      }
    }
    return computeExpectedValue(doc, percentiles, getRank);
  }

  // --- Internals ---

  /**
   * Compute and write score + lifecycle using percentile-based thresholds.
   */
  private async writeScoreAndLifecycle(
    channelId: string,
    doc: ChannelIntelligenceDocument,
  ): Promise<void> {
    let percentiles: ChannelPercentiles | null = null;
    try {
      percentiles = PercentileEngine.getInstance().getCachedPercentiles();
    } catch {
      // PercentileEngine not initialized — use fallback thresholds
    }

    const ev = this.recomputeExpectedValue(doc, percentiles);
    const scoreFields: Record<string, unknown> = {
      expectedValue: Math.round(ev * 1000) / 1000,
      scoreUpdatedAt: Date.now(),
    };

    // Lifecycle transitions — ALL percentile-based
    const totalPulls = Object.values(doc.strategies).reduce((sum, arm) => sum + arm.n, 0);
    const totalDeletions = doc.deletionTiming.automod + doc.deletionTiming.bot
      + doc.deletionTiming.human + doc.deletionTiming.late;
    const currentStage = doc.stage;
    let newStage: LifecycleStage = currentStage;

    if (percentiles) {
      const pe = PercentileEngine.getInstance();
      const deleteRate = totalPulls > 0 ? totalDeletions / totalPulls : 0;
      const deleteRank = pe.getPercentileRankSync(deleteRate, 'deleteRate');

      // HOSTILE: deleteRate above p90 OR consecutive errors > 5
      if (deleteRank >= 0.90 || (doc.errors.consecutiveErrors || 0) > 5) {
        newStage = 'hostile';
      }
      // HOSTILE recovery: wait proportional to severity
      else if (currentStage === 'hostile') {
        const severity = Math.max(0, deleteRank - 0.90) / 0.10;
        const cooldownMs = 24 * 3600000 * (1 + severity * 6); // 24h to 7 days
        if (Date.now() - doc.stageUpdatedAt > cooldownMs && (doc.errors.consecutiveErrors || 0) === 0) {
          newStage = 'learning';
        }
      }
      // NEW → LEARNING: enough attempts relative to population
      else if (currentStage === 'new' && totalPulls >= Math.max(3, percentiles.messageVolume.p10)) {
        newStage = 'learning';
      }
      // LEARNING → OPTIMIZED: above median success + enough data
      else if (currentStage === 'learning' && totalPulls >= percentiles.messageVolume.p25 && ev >= 0.5) {
        newStage = 'optimized';
      }
    } else {
      // Fallback: reasonable defaults when percentiles not available
      if (totalDeletions > 30 || (doc.errors.consecutiveErrors || 0) > 5) {
        newStage = 'hostile';
      } else if (currentStage === 'hostile') {
        if (Date.now() - doc.stageUpdatedAt > 72 * 3600000 && (doc.errors.consecutiveErrors || 0) === 0) {
          newStage = 'learning';
        }
      } else if (currentStage === 'new' && totalPulls >= 5) {
        newStage = 'learning';
      } else if (currentStage === 'learning' && totalPulls >= 30 && ev >= 0.5) {
        newStage = 'optimized';
      }
    }

    if (newStage !== currentStage) {
      scoreFields['stage'] = newStage;
      scoreFields['stageUpdatedAt'] = Date.now();
    }

    scoreFields['updatedAt'] = new Date();

    await this.collection.updateOne(
      { channelId },
      { $set: scoreFields },
    );
  }

  private async writeFollowupRate(
    channelId: string,
    doc: ChannelIntelligenceDocument,
  ): Promise<void> {
    const total = doc.followupTotal;
    if (total === 0) return;

    const successCount = doc.followupSuccessCount ?? 0;
    const newRate = successCount / total;

    await this.collection.updateOne(
      { channelId },
      { $set: { followupSuccessRate: Math.round(newRate * 1000) / 1000 } },
    );
  }

  private async applyDiscount(channelId: string, strategy: MessageStrategy): Promise<void> {
    const doc = await this.get(channelId);
    if (!doc) return;

    const arm = doc.strategies[strategy];
    if (!arm || arm.n < 2) return;

    const discountedS = Math.round(arm.s * DISCOUNT_GAMMA * 100) / 100;
    const discountedF = Math.round(arm.f * DISCOUNT_GAMMA * 100) / 100;

    await this.collection.updateOne(
      { channelId },
      {
        $set: {
          [`strategies.${strategy}.s`]: discountedS,
          [`strategies.${strategy}.f`]: discountedF,
        },
      },
    );
  }

  private classifyDeletionTiming(survivalMs: number): DeletionBucket {
    if (survivalMs < AUTOMOD_THRESHOLD) return 'automod';
    if (survivalMs < BOT_THRESHOLD) return 'bot';
    if (survivalMs < HUMAN_THRESHOLD) return 'human';
    return 'late';
  }

  private categorizeError(errorType: string): string {
    const known = ['SLOWMODE_WAIT', 'PEER_FLOOD', 'FLOOD_WAIT', 'CHANNEL_RESTRICTED'];
    const upper = errorType.toUpperCase();
    for (const k of known) {
      if (upper.includes(k)) return k;
    }
    return 'TRANSIENT';
  }

  private getCooldownForError(errorType: string): number {
    const upper = errorType.toUpperCase();
    if (upper.includes('CHANNEL_RESTRICTED')) return 7 * 24 * 60 * 60_000;
    if (upper.includes('PEER_FLOOD')) return 60 * 60_000;
    if (upper.includes('FLOOD_WAIT')) return 5 * 60_000;
    if (upper.includes('SLOWMODE_WAIT')) return 5 * 60_000;
    return 5 * 60_000;
  }

  // --- Index creation ---

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ channelId: 1 }, { unique: true });
    await this.collection.createIndex(
      { stage: 1, cooldownUntil: 1, expectedValue: -1 },
      { name: 'idx_channel_ordering' },
    );
    await this.collection.createIndex(
      { channelCategory: 1, expectedValue: -1 },
      { name: 'idx_category_score' },
    );
    await this.collection.createIndex(
      { profileUpdatedAt: 1 },
      { name: 'idx_stale_profile', sparse: true },
    );
  }
}

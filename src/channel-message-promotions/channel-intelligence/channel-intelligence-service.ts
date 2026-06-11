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

import type {
  ChannelIntelligenceDocument,
  LifecycleStage,
  MessageStrategy,
  ChannelCategory,
} from './channel-intelligence.types';
import type { CursorLike, MongoCollectionLike } from '../../types';
import { ALL_STRATEGIES, createDefaultIntelligence, createDefaultStrategies } from './channel-intelligence.types';
import { PercentileEngine } from './percentile-engine';
import { ChannelClassifier } from './channel-classifier';
import { computeExpectedValue } from '../scoring/expected-value';
import type { ChannelPercentiles } from '../../types';
import { normalizeChannelId, normalizeChannelIds } from '../utils/channel-id';

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
  private static instance: ChannelIntelligenceService | undefined;
  private collection: MongoCollectionLike<ChannelIntelligenceDocument>;

  constructor(collection: MongoCollectionLike<ChannelIntelligenceDocument>) {
    if (!isCollectionLike(collection)) {
      throw new Error('ChannelIntelligenceService collection is required');
    }
    this.collection = collection;
  }

  static init(
    collection: MongoCollectionLike<ChannelIntelligenceDocument>,
    options: { replace?: boolean } = {},
  ): ChannelIntelligenceService {
    if (!ChannelIntelligenceService.instance || shouldReplace(options)) {
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

  static reset(): void {
    ChannelIntelligenceService.instance = undefined;
  }

  // --- Read ---

  async get(channelId: string): Promise<ChannelIntelligenceDocument | null> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return null;
    return this.collection.findOne({ channelId: safeChannelId });
  }

  async batchGet(
    channelIds: string[],
    projection?: Record<string, 1>,
  ): Promise<ChannelIntelligenceDocument[]> {
    const safeChannelIds = normalizeChannelIds(channelIds);
    if (safeChannelIds.length === 0) return [];
    const opts = projection ? { projection } : undefined;
    const rows = await readCursorArray<ChannelIntelligenceDocument>(
      this.collection.find({ channelId: { $in: safeChannelIds } }, opts),
    );
    return rows.filter(isChannelIntelligenceDocument);
  }

  async getTopChannels(limit: number = 50): Promise<ChannelIntelligenceDocument[]> {
    const safeLimit = normalizeLimit(limit, 50);
    const cursor = this.collection.find({
      stage: { $nin: ['hostile'] },
      cooldownUntil: { $lte: Date.now() },
    });
    if (!isSortableCursorLike(cursor)) return [];
    const rows = await readCursorArray<ChannelIntelligenceDocument>(
      cursor
        .sort({ expectedValue: -1 })
        .limit(safeLimit),
    );
    return rows.filter(isChannelIntelligenceDocument);
  }

  /**
   * Recover hostile channels that have cooled down.
   * Hostile channels are excluded from promotion selection, so their stage never gets
   * re-evaluated. This method finds eligible hostile channels and resets them to 'learning'.
   * Should be called periodically (e.g., once per health check cycle).
   */
  async recoverStaleHostileChannels(): Promise<number> {
    const threeDaysAgo = Date.now() - 3 * 24 * 3600000;
    const filter = {
      stage: 'hostile',
      stageUpdatedAt: { $lt: threeDaysAgo },
    };
    const update = { $set: { stage: 'learning', stageUpdatedAt: Date.now(), 'errors.consecutiveErrors': 0 } };
    if (this.collection.updateMany) {
      const result = await this.collection.updateMany(filter, update);
      return result.modifiedCount;
    }
    // Fallback: iterate and updateOne
    const cursor = this.collection.find(filter);
    let count = 0;
    const docs = await readCursorArray<ChannelIntelligenceDocument>(cursor);
    for (const doc of docs) {
      await this.collection.updateOne({ channelId: doc.channelId }, update);
      count++;
    }
    return count;
  }

  // --- Upsert ---

  async ensureDoc(channelId: string, topic: string = 'general_chat'): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const safeTopic = normalizeLabel(topic, 'general_chat');
    const defaults = createDefaultIntelligence(safeChannelId, safeTopic);
    await this.collection.updateOne(
      { channelId: safeChannelId },
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
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const safeStrategy = normalizeMessageStrategy(strategy);
    await this.ensureDoc(safeChannelId);
    await this.ensureWritableSubdocuments(safeChannelId, safeStrategy);
    await this.repairNumericFields(
      safeChannelId,
      isFollowup
        ? ['totalSendsToChannel', 'followupTotal', 'followupSuccessCount']
        : ['totalSendsToChannel'],
    );
    await this.applyDiscount(safeChannelId, safeStrategy);

    const incFields: Record<string, number> = {
      [`strategies.${safeStrategy}.s`]: 1,
      [`strategies.${safeStrategy}.n`]: 1,
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
      { channelId: safeChannelId },
      { $inc: incFields, $set: setFields },
      { returnDocument: 'after' },
    );
    if (!doc) return;

    if (isFollowup) {
      doc.followupSuccessRate = await this.writeFollowupRate(safeChannelId, doc);
    }

    await this.writeScoreAndLifecycle(safeChannelId, doc);
  }

  async recordDeletion(
    channelId: string,
    strategy: MessageStrategy,
    survivalMs: number,
    isFollowup: boolean,
  ): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const safeStrategy = normalizeMessageStrategy(strategy);
    await this.ensureDoc(safeChannelId);
    await this.ensureWritableSubdocuments(safeChannelId, safeStrategy);
    if (isFollowup) {
      await this.repairNumericFields(safeChannelId, ['followupTotal']);
    }

    const bucket = this.classifyDeletionTiming(survivalMs);
    await this.applyDiscount(safeChannelId, safeStrategy);

    const incFields: Record<string, number> = {
      [`strategies.${safeStrategy}.f`]: 1,
      [`strategies.${safeStrategy}.n`]: 1,
      [`deletionTiming.${bucket}`]: 1,
    };

    if (isFollowup) {
      incFields['followupTotal'] = 1;
    }

    const doc = await this.collection.findOneAndUpdate(
      { channelId: safeChannelId },
      {
        $inc: incFields,
        $set: { updatedAt: new Date() },
      },
      { returnDocument: 'after' },
    );
    if (!doc) return;

    if (isFollowup) {
      doc.followupSuccessRate = await this.writeFollowupRate(safeChannelId, doc);
    }

    await this.writeScoreAndLifecycle(safeChannelId, doc);
  }

  async recordFailure(
    channelId: string,
    strategy: MessageStrategy,
    errorType: string,
  ): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const safeStrategy = normalizeMessageStrategy(strategy);
    await this.ensureDoc(safeChannelId);
    await this.ensureWritableSubdocuments(safeChannelId, safeStrategy);

    const now = Date.now();
    const safeErrorType = normalizeErrorType(errorType);
    const errorCategory = this.categorizeError(safeErrorType);
    const accountOnly = isAccountSpecificError(safeErrorType.toUpperCase());
    await this.applyDiscount(safeChannelId, safeStrategy);

    const incFields: Record<string, number> = {
      [`strategies.${safeStrategy}.f`]: accountOnly ? 0 : 1,
      [`strategies.${safeStrategy}.n`]: accountOnly ? 0 : 1,
      [`errors.${errorCategory}`]: 1,
    };
    // Only increment consecutiveErrors for channel-level issues, not per-account bans/floods
    if (!accountOnly) {
      incFields['errors.consecutiveErrors'] = 1;
    }

    const setFields: Record<string, unknown> = {
      'errors.lastErrorType': safeErrorType,
      'errors.lastErrorAt': now,
      updatedAt: new Date(),
    };

    const cooldownMs = this.getCooldownForError(safeErrorType);
    if (cooldownMs > 0 && !accountOnly) {
      setFields['cooldownUntil'] = now + cooldownMs;
    }

    const doc = await this.collection.findOneAndUpdate(
      { channelId: safeChannelId },
      { $inc: incFields, $set: setFields },
      { returnDocument: 'after' },
    );
    if (!doc) return;

    await this.writeScoreAndLifecycle(safeChannelId, doc);
  }

  // --- Conversion recording (ROI) ---

  async recordConversion(channelId: string, fractionalWeight: number): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const weight = this.normalizeFractionalWeight(fractionalWeight);
    if (weight === null) return;

    await this.ensureDoc(safeChannelId);
    await this.repairNumericFields(safeChannelId, ['conversions']);
    const doc = await this.collection.findOneAndUpdate(
      { channelId: safeChannelId },
      {
        $inc: { conversions: weight },
        $set: { conversionUpdatedAt: Date.now(), updatedAt: new Date() },
      },
      { returnDocument: 'after' },
    );
    if (doc) {
      await this.writeScoreAndLifecycle(safeChannelId, doc);
    }
  }

  async recordPaidConversion(channelId: string, fractionalWeight: number): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const weight = this.normalizeFractionalWeight(fractionalWeight);
    if (weight === null) return;

    await this.ensureDoc(safeChannelId);
    await this.repairNumericFields(safeChannelId, ['paidConversions']);
    const doc = await this.collection.findOneAndUpdate(
      { channelId: safeChannelId },
      {
        $inc: { paidConversions: weight },
        $set: { conversionUpdatedAt: Date.now(), updatedAt: new Date() },
      },
      { returnDocument: 'after' },
    );
    if (doc) {
      await this.writeScoreAndLifecycle(safeChannelId, doc);
    }
  }

  // --- Channel classification ---

  async updateClassification(
    channelId: string,
    classification: { category: ChannelCategory; confidence: number; promotionFitScore: number },
  ): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const safeClassification: Record<string, unknown> = isRecord(classification) ? classification : {};
    const category = isChannelCategory(safeClassification['category']) ? safeClassification['category'] : 'unclassified';
    await this.collection.updateOne(
      { channelId: safeChannelId },
      {
        $set: {
          channelCategory: category,
          categoryConfidence: clamp01(asNumber(safeClassification['confidence'])),
          promotionFitScore: clamp01(asNumber(safeClassification['promotionFitScore'])),
          categoryUpdatedAt: Date.now(),
          updatedAt: new Date(),
        },
      },
    );
  }

  // --- Saturation update ---

  async updateSaturationRate(channelId: string, participantsCount: number): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const doc = await this.get(safeChannelId);
    const safeParticipantsCount = safePositive(participantsCount);
    if (!doc || safeParticipantsCount === null) return;

    const rate = safeNonNegative(doc.totalSendsToChannel) / safeParticipantsCount;
    await this.collection.updateOne(
      { channelId: safeChannelId },
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
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const doc = await this.get(safeChannelId);
    if (!doc) return;

    const totalPulls = sumStrategyPulls(doc.strategies);

    // Reclassify every ~50 pulls (and on first classification)
    if (totalPulls % 50 < 2 || doc.channelCategory === 'unclassified') {
      const classification = ChannelClassifier.classify(title, username, doc);
      await this.updateClassification(safeChannelId, classification);
    }

    // Update saturation rate on every call (lightweight)
    const safeParticipantsCount = safePositive(participantsCount);
    if (safeParticipantsCount !== null) {
      const rate = safeNonNegative(doc.totalSendsToChannel) / safeParticipantsCount;
      await this.collection.updateOne(
        { channelId: safeChannelId },
        { $set: { saturationRate: Math.round(rate * 1000) / 1000, updatedAt: new Date() } },
      );
    }
  }

  // --- GramJS signal updates ---

  async updateOnlineTrend(channelId: string, onlineCount: number): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const doc = await this.get(safeChannelId);
    if (!doc) return;

    const safeOnlineCount = safeNonNegative(onlineCount);
    const onlineTrend = asRecord(doc.onlineTrend);
    const prevEwma = safeNonNegative(onlineTrend['ewma']);
    const sampleCount = safeNonNegative(onlineTrend['sampleCount']);
    const newEwma = sampleCount === 0
      ? safeOnlineCount
      : prevEwma * (1 - EWMA_ALPHA) + safeOnlineCount * EWMA_ALPHA;

    await this.collection.updateOne(
      { channelId: safeChannelId },
      {
        $set: {
          'onlineTrend.ewma': Math.round(newEwma * 100) / 100,
          'onlineTrend.lastSampled': Date.now(),
          'onlineTrend.sampleCount': sampleCount + 1,
          updatedAt: new Date(),
        },
      },
    );
  }

  async updateViewEngagement(
    channelId: string,
    views: number,
    participantsCount: number,
  ): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const safeViews = safeNonNegativeInput(views);
    const safeParticipantsCount = safePositive(participantsCount);
    if (safeParticipantsCount === null || safeViews === null) return;

    const ratio = safeViews / safeParticipantsCount;
    const doc = await this.get(safeChannelId);
    if (!doc) return;

    const viewEngagement = asRecord(doc.viewEngagement);
    const prevRatio = safeNonNegative(viewEngagement['ewmaRatio']);
    const checksCount = safeNonNegative(viewEngagement['checksCount']);
    const newRatio = checksCount === 0
      ? ratio
      : prevRatio * (1 - EWMA_ALPHA) + ratio * EWMA_ALPHA;

    await this.collection.updateOne(
      { channelId: safeChannelId },
      {
        $set: {
          'viewEngagement.ewmaRatio': Math.round(newRatio * 1000) / 1000,
          'viewEngagement.lastChecked': Date.now(),
          'viewEngagement.checksCount': checksCount + 1,
          updatedAt: new Date(),
        },
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
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    const safeTopic = normalizeLabel(topic, 'general_chat');
    const safeLanguage = normalizeLabel(language, 'unknown');
    await this.ensureDoc(safeChannelId, safeTopic);

    await this.collection.updateOne(
      { channelId: safeChannelId },
      {
        $set: {
          topic: safeTopic,
          topicConfidence: clamp01(topicConfidence),
          language: safeLanguage,
          languageConfidence: clamp01(languageConfidence),
          profileUpdatedAt: Date.now(),
          updatedAt: new Date(),
        },
      },
    );
  }

  // --- Promotion tracking ---

  async recordPromotion(channelId: string): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    await this.ensureDoc(safeChannelId);
    await this.collection.updateOne(
      { channelId: safeChannelId },
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
    const totalPulls = sumStrategyPulls(doc.strategies);
    const deletionTiming = asRecord(doc.deletionTiming);
    const totalDeletions = safeNonNegative(deletionTiming['automod']) + safeNonNegative(deletionTiming['bot'])
      + safeNonNegative(deletionTiming['human']) + safeNonNegative(deletionTiming['late']);
    const errors = asRecord(doc.errors);
    const currentStage = doc.stage;
    let newStage: LifecycleStage = currentStage;

    if (percentiles) {
      const pe = PercentileEngine.getInstance();
      const deleteRate = totalPulls > 0 ? totalDeletions / totalPulls : 0;
      const deleteRank = pe.getPercentileRankSync(deleteRate, 'deleteRate');

      // HOSTILE: only from confirmed channel-level moderation (high deletion rate)
      // Account-specific errors (bans, floods) are handled in-memory per process
      if (deleteRate > 0.3 && deleteRank >= 0.90) {
        newStage = 'hostile';
      }
      // HOSTILE recovery: wait proportional to severity
      else if (currentStage === 'hostile') {
        const severity = Math.max(0, deleteRank - 0.90) / 0.10;
        const cooldownMs = 24 * 3600000 * (1 + severity * 6); // 24h to 7 days
        if (Date.now() - safeTimestamp(doc.stageUpdatedAt) > cooldownMs && safeNonNegative(errors['consecutiveErrors']) === 0) {
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
      const fallbackDeleteRate = totalPulls > 0 ? totalDeletions / totalPulls : 0;
      if (fallbackDeleteRate > 0.3 && totalDeletions > 10) {
        newStage = 'hostile';
      } else if (currentStage === 'hostile') {
        if (Date.now() - safeTimestamp(doc.stageUpdatedAt) > 72 * 3600000 && safeNonNegative(errors['consecutiveErrors']) === 0) {
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

  private async ensureWritableSubdocuments(channelId: string, strategy: MessageStrategy): Promise<void> {
    const doc = await this.get(channelId);
    if (!doc) return;

    const setFields: Record<string, unknown> = {};
    const strategies = asRecord(doc.strategies);
    if (!isRecord(doc.strategies)) {
      setFields['strategies'] = createDefaultStrategies();
    } else {
      const arm = strategies[strategy];
      if (!isRecord(arm)) {
        setFields[`strategies.${strategy}`] = { s: 0, f: 0, n: 0 };
      } else {
        repairNumericLeaf(setFields, `strategies.${strategy}.s`, arm['s']);
        repairNumericLeaf(setFields, `strategies.${strategy}.f`, arm['f']);
        repairNumericLeaf(setFields, `strategies.${strategy}.n`, arm['n']);
      }
    }
    if (!isRecord(doc.deletionTiming)) {
      setFields['deletionTiming'] = { automod: 0, bot: 0, human: 0, late: 0 };
    } else {
      const deletionTiming = asRecord(doc.deletionTiming);
      repairNumericLeaf(setFields, 'deletionTiming.automod', deletionTiming['automod']);
      repairNumericLeaf(setFields, 'deletionTiming.bot', deletionTiming['bot']);
      repairNumericLeaf(setFields, 'deletionTiming.human', deletionTiming['human']);
      repairNumericLeaf(setFields, 'deletionTiming.late', deletionTiming['late']);
    }
    if (!isRecord(doc.errors)) {
      setFields['errors'] = { consecutiveErrors: 0 };
    } else {
      const errors = asRecord(doc.errors);
      repairNumericLeaf(setFields, 'errors.SLOWMODE_WAIT', errors['SLOWMODE_WAIT']);
      repairNumericLeaf(setFields, 'errors.PEER_FLOOD', errors['PEER_FLOOD']);
      repairNumericLeaf(setFields, 'errors.FLOOD_WAIT', errors['FLOOD_WAIT']);
      repairNumericLeaf(setFields, 'errors.CHANNEL_RESTRICTED', errors['CHANNEL_RESTRICTED']);
      repairNumericLeaf(setFields, 'errors.TRANSIENT', errors['TRANSIENT']);
      repairNumericLeaf(setFields, 'errors.consecutiveErrors', errors['consecutiveErrors']);
    }
    if (!isRecord(doc.onlineTrend)) {
      setFields['onlineTrend'] = { ewma: 0, lastSampled: 0, sampleCount: 0 };
    }
    if (!isRecord(doc.viewEngagement)) {
      setFields['viewEngagement'] = { ewmaRatio: 0, lastChecked: 0, checksCount: 0 };
    }

    if (Object.keys(setFields).length === 0) return;
    await this.collection.updateOne(
      { channelId },
      { $set: { ...setFields, updatedAt: new Date() } },
    );
  }

  private async repairNumericFields(channelId: string, paths: string[]): Promise<void> {
    const doc = await this.get(channelId);
    if (!doc) return;
    const setFields: Record<string, unknown> = {};
    for (const path of paths) {
      repairNumericLeaf(setFields, path, readPath(doc, path));
    }
    if (Object.keys(setFields).length === 0) return;
    await this.collection.updateOne(
      { channelId },
      { $set: { ...setFields, updatedAt: new Date() } },
    );
  }

  private async writeFollowupRate(
    channelId: string,
    doc: ChannelIntelligenceDocument,
  ): Promise<number> {
    const total = safeNonNegative(doc.followupTotal);
    if (total === 0) return safeRate(doc.followupSuccessRate, 0.5);

    const successCount = safeNonNegative(doc.followupSuccessCount);
    const newRate = Math.round(Math.min(1, successCount / total) * 1000) / 1000;

    await this.collection.updateOne(
      { channelId },
      { $set: { followupSuccessRate: newRate } },
    );
    return newRate;
  }

  private async applyDiscount(channelId: string, strategy: MessageStrategy): Promise<void> {
    const doc = await this.get(channelId);
    if (!doc) return;

    const arm = asRecord(asRecord(doc.strategies)[strategy]);
    if (safeNonNegative(arm['n']) < 2) return;

    const discountedS = Math.round(safeNonNegative(arm['s']) * DISCOUNT_GAMMA * 100) / 100;
    const discountedF = Math.round(safeNonNegative(arm['f']) * DISCOUNT_GAMMA * 100) / 100;

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
    if (!Number.isFinite(survivalMs) || survivalMs < 0) return 'automod';
    if (survivalMs < AUTOMOD_THRESHOLD) return 'automod';
    if (survivalMs < BOT_THRESHOLD) return 'bot';
    if (survivalMs < HUMAN_THRESHOLD) return 'human';
    return 'late';
  }

  private categorizeError(errorType: string): string {
    const known = ['SLOWMODE_WAIT', 'PEER_FLOOD', 'FLOOD_WAIT', 'CHANNEL_RESTRICTED'];
    const upper = errorType.toUpperCase();
    if (isTerminalChannelError(upper)) return 'CHANNEL_RESTRICTED';
    for (const k of known) {
      if (upper.includes(k)) return k;
    }
    return 'TRANSIENT';
  }

  private getCooldownForError(errorType: string): number {
    const upper = errorType.toUpperCase();
    if (upper.includes('CHANNEL_RESTRICTED') || isTerminalChannelError(upper)) return 7 * 24 * 60 * 60_000;
    if (upper.includes('PEER_FLOOD')) return 60 * 60_000;
    if (upper.includes('FLOOD_WAIT')) return Math.max(5 * 60_000, parseWaitSeconds(upper) * 1000);
    if (upper.includes('SLOWMODE_WAIT')) return Math.max(5 * 60_000, parseWaitSeconds(upper) * 1000);
    return 5 * 60_000;
  }

  private normalizeFractionalWeight(value: number): number | null {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.min(1, value);
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

function sumStrategyPulls(value: unknown): number {
  return Object.values(asRecord(value)).reduce<number>((sum, arm) => {
    const armRecord = asRecord(arm);
    return sum + safeNonNegative(armRecord['n']);
  }, 0);
}

function safeNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function safeRate(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function repairNumericLeaf(setFields: Record<string, unknown>, path: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    setFields[path] = 0;
  }
}

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (
    isRecord(current) ? current[key] : undefined
  ), value);
}

function safePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function safeNonNegativeInput(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeLimit(value: number, fallback: number): number {
  const normalized = Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(normalized, 500));
}

function normalizeMessageStrategy(value: unknown): MessageStrategy {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (ALL_STRATEGIES as string[]).includes(normalized)
    ? normalized as MessageStrategy
    : 'legacy';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isChannelCategory(value: unknown): value is ChannelCategory {
  return value === 'high_intent'
    || value === 'social_chat'
    || value === 'regional_social'
    || value === 'off_topic'
    || value === 'unclassified';
}

function normalizeErrorType(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'TRANSIENT';
}

function isTerminalChannelError(value: string): boolean {
  return value.includes('CHANNEL_PRIVATE')
    || value.includes('CHANNEL_INVALID')
    || value.includes('PEER_ID_INVALID')
    || value.includes('TOPIC_CLOSED')
    || value.includes('TOPIC_DELETED');
}

export function isAccountSpecificError(value: string): boolean {
  return value.includes('CHAT_WRITE_FORBIDDEN')
    || value.includes('USER_BANNED_IN_CHANNEL')
    || value.includes('USER_NOT_PARTICIPANT')
    || value.includes('CHAT_ADMIN_REQUIRED')
    || value.includes('FLOOD_WAIT')
    || value.includes('SLOWMODE_WAIT')
    || value.includes('PEER_FLOOD');
}

function parseWaitSeconds(value: string): number {
  const match = value.match(/(?:FLOOD_WAIT|SLOWMODE_WAIT)_?(\d+)/);
  if (!match) return 0;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function normalizeLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCollectionLike(value: unknown): value is MongoCollectionLike<ChannelIntelligenceDocument> {
  return isRecord(value)
    && typeof value['findOne'] === 'function'
    && typeof value['find'] === 'function'
    && typeof value['updateOne'] === 'function'
    && typeof value['findOneAndUpdate'] === 'function'
    && typeof value['createIndex'] === 'function';
}

async function readCursorArray<T>(cursor: unknown): Promise<T[]> {
  if (!isCursorToArrayLike<T>(cursor)) return [];
  const rows = await cursor.toArray();
  return Array.isArray(rows) ? rows : [];
}

function isCursorToArrayLike<T>(value: unknown): value is Pick<CursorLike<T>, 'toArray'> {
  return isRecord(value) && typeof value['toArray'] === 'function';
}

function isSortableCursorLike<T>(value: unknown): value is CursorLike<T> {
  return isRecord(value)
    && typeof value['toArray'] === 'function'
    && typeof value['sort'] === 'function'
    && typeof value['limit'] === 'function';
}

function isChannelIntelligenceDocument(value: unknown): value is ChannelIntelligenceDocument {
  return isRecord(value) && normalizeChannelId(value['channelId']) !== null;
}

function shouldReplace(options: unknown): boolean {
  return isRecord(options) && options['replace'] === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

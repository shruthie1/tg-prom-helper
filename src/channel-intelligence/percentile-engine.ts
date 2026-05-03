/**
 * Percentile Engine — computes dynamic thresholds from activeChannels collection.
 *
 * Cached in Redis (cross-process sharing) and in-memory (per-process).
 * Both promote-clients and tg-aut read the same Redis cache.
 * Refreshes every 30 minutes.
 */

import type { Collection } from 'mongodb';
import type { Redis } from 'ioredis';
import type { ChannelPercentiles, PercentileBuckets } from '../types';

const REDIS_KEY = 'percentiles:channels';
const REDIS_TTL = 3600; // 1 hour
const REFRESH_MS = 30 * 60 * 1000; // 30 minutes

/** Accepts any typed MongoDB Collection — only aggregate() is used */
interface AggregateableCollection {
  aggregate(pipeline: object[]): { toArray(): Promise<Record<string, any>[]> };
}

export class PercentileEngine {
  private static instance: PercentileEngine;

  private cache: ChannelPercentiles | null = null;
  private lastComputed = 0;

  constructor(
    private activeChannelCollection: AggregateableCollection,
    private redis: Redis,
    private intelligenceCollection?: AggregateableCollection,
  ) {}

  static init(collection: AggregateableCollection, redis: Redis, intelligenceCollection?: AggregateableCollection): PercentileEngine {
    if (!PercentileEngine.instance) {
      PercentileEngine.instance = new PercentileEngine(collection, redis, intelligenceCollection);
    }
    return PercentileEngine.instance;
  }

  static getInstance(): PercentileEngine {
    if (!PercentileEngine.instance) {
      throw new Error('PercentileEngine not initialized. Call PercentileEngine.init() first.');
    }
    return PercentileEngine.instance;
  }

  async getPercentiles(): Promise<ChannelPercentiles> {
    if (this.cache && Date.now() - this.lastComputed < REFRESH_MS) {
      return this.cache;
    }

    // Try Redis first (cross-process sharing)
    try {
      const cached = await this.redis.get(REDIS_KEY);
      if (cached) {
        const parsed: ChannelPercentiles = JSON.parse(cached);
        this.cache = parsed;
        this.lastComputed = Date.now();
        return parsed;
      }
    } catch {
      // Redis unavailable, compute fresh
    }

    return this.computeAndCache();
  }

  /**
   * Synchronous access to cached percentiles. Returns null if not yet computed.
   * Use getPercentiles() for guaranteed data.
   */
  getCachedPercentiles(): ChannelPercentiles | null {
    return this.cache;
  }

  /**
   * Returns percentile rank (0.0 to 1.0) of a value within a metric.
   * Uses interpolation between bucket boundaries.
   * Async version — ensures percentiles are loaded.
   */
  async getPercentileRank(value: number, metric: keyof ChannelPercentiles): Promise<number> {
    const percentiles = await this.getPercentiles();
    return this.computeRank(value, percentiles[metric]);
  }

  /**
   * Synchronous percentile rank — uses cached data only.
   * Returns 0.5 (median assumption) if cache is empty.
   */
  getPercentileRankSync(value: number, metric: keyof ChannelPercentiles): number {
    const p = this.cache?.[metric];
    if (!p || p.count === 0) return 0.5;
    return this.computeRank(value, p);
  }

  private computeRank(value: number, p: PercentileBuckets): number {
    if (p.count === 0) return 0.5;
    if (value <= p.p10) return 0.05 + 0.05 * (value / Math.max(0.001, p.p10));
    if (value <= p.p25) return 0.10 + 0.15 * ((value - p.p10) / Math.max(0.001, p.p25 - p.p10));
    if (value <= p.p50) return 0.25 + 0.25 * ((value - p.p25) / Math.max(0.001, p.p50 - p.p25));
    if (value <= p.p75) return 0.50 + 0.25 * ((value - p.p50) / Math.max(0.001, p.p75 - p.p50));
    if (value <= p.p90) return 0.75 + 0.15 * ((value - p.p75) / Math.max(0.001, p.p90 - p.p75));
    return 0.90 + 0.10 * Math.min(1, (value - p.p90) / Math.max(0.001, p.p90 - p.p75));
  }

  private async computeAndCache(): Promise<ChannelPercentiles> {
    const pipeline = [
      { $match: { banned: { $ne: true }, forbidden: { $ne: true } } },
      {
        $addFields: {
          _totalAttempts: {
            $add: [
              { $ifNull: ['$successMsgCount', 0] },
              { $ifNull: ['$failureMsgCount', 0] },
            ],
          },
          _successRate: {
            $cond: [
              {
                $gt: [
                  { $add: [{ $ifNull: ['$successMsgCount', 0] }, { $ifNull: ['$failureMsgCount', 0] }] },
                  4,
                ],
              },
              {
                $divide: [
                  { $ifNull: ['$successMsgCount', 0] },
                  { $add: [{ $ifNull: ['$successMsgCount', 0] }, { $ifNull: ['$failureMsgCount', 0] }] },
                ],
              },
              null,
            ],
          },
          _deleteRate: {
            $cond: [
              { $gt: [{ $ifNull: ['$successMsgCount', 0] }, 0] },
              {
                $divide: [
                  { $ifNull: ['$deletedCount', 0] },
                  { $ifNull: ['$successMsgCount', 0] },
                ],
              },
              null,
            ],
          },
          _saturation: {
            $cond: [
              {
                $and: [
                  { $gt: [{ $ifNull: ['$successMsgCount', 0] }, 0] },
                  { $gt: [{ $ifNull: ['$participantsCount', 0] }, 0] },
                ],
              },
              {
                $divide: [
                  {
                    $add: [
                      { $ifNull: ['$successMsgCount', 0] },
                      { $ifNull: ['$followupMsgSuccessCount', 0] },
                    ],
                  },
                  '$participantsCount',
                ],
              },
              null,
            ],
          },
        },
      },
      {
        $facet: {
          successRateValues: [
            { $match: { _successRate: { $ne: null } } },
            { $sort: { _successRate: 1 } },
            { $group: { _id: null, values: { $push: '$_successRate' }, count: { $sum: 1 } } },
          ],
          deleteRateValues: [
            { $match: { _deleteRate: { $ne: null } } },
            { $sort: { _deleteRate: 1 } },
            { $group: { _id: null, values: { $push: '$_deleteRate' }, count: { $sum: 1 } } },
          ],
          participantsValues: [
            { $match: { participantsCount: { $gt: 0 } } },
            { $sort: { participantsCount: 1 } },
            { $group: { _id: null, values: { $push: '$participantsCount' }, count: { $sum: 1 } } },
          ],
          deletedCountValues: [
            { $sort: { deletedCount: 1 } },
            { $group: { _id: null, values: { $push: { $ifNull: ['$deletedCount', 0] } }, count: { $sum: 1 } } },
          ],
          messageVolumeValues: [
            { $match: { _totalAttempts: { $gt: 0 } } },
            { $sort: { _totalAttempts: 1 } },
            { $group: { _id: null, values: { $push: '$_totalAttempts' }, count: { $sum: 1 } } },
          ],
          saturationValues: [
            { $match: { _saturation: { $ne: null } } },
            { $sort: { _saturation: 1 } },
            { $group: { _id: null, values: { $push: '$_saturation' }, count: { $sum: 1 } } },
          ],
        },
      },
    ];

    const [result] = await this.activeChannelCollection.aggregate(pipeline).toArray();

    this.cache = {
      successRate: this.extractBuckets(result.successRateValues),
      deleteRate: this.extractBuckets(result.deleteRateValues),
      participantsCount: this.extractBuckets(result.participantsValues),
      deletedCount: this.extractBuckets(result.deletedCountValues),
      messageVolume: this.extractBuckets(result.messageVolumeValues),
      saturationRate: this.extractBuckets(result.saturationValues),
      followupSurvivalRate: { p10: 0, p25: 0.2, p50: 0.5, p75: 0.7, p90: 0.9, count: 0 },
      conversionRate: { p10: 0, p25: 0, p50: 0, p75: 0.01, p90: 0.05, count: 0 },
    };

    // Compute followupSurvivalRate and conversionRate from intelligence collection
    if (this.intelligenceCollection) {
      try {
        const [intelResult] = await this.intelligenceCollection.aggregate([
          {
            $facet: {
              followupRateValues: [
                { $match: { followupTotal: { $gt: 4 } } },
                { $addFields: { _fuRate: { $divide: ['$followupSuccessCount', '$followupTotal'] } } },
                { $sort: { _fuRate: 1 } },
                { $group: { _id: null, values: { $push: '$_fuRate' }, count: { $sum: 1 } } },
              ],
              conversionRateValues: [
                { $match: { conversions: { $gt: 0 }, totalSendsToChannel: { $gt: 0 } } },
                { $addFields: { _convRate: { $divide: ['$conversions', '$totalSendsToChannel'] } } },
                { $sort: { _convRate: 1 } },
                { $group: { _id: null, values: { $push: '$_convRate' }, count: { $sum: 1 } } },
              ],
            },
          },
        ]).toArray();

        if (intelResult) {
          const fuBuckets = this.extractBuckets(intelResult.followupRateValues);
          if (fuBuckets.count > 0) this.cache.followupSurvivalRate = fuBuckets;
          const convBuckets = this.extractBuckets(intelResult.conversionRateValues);
          if (convBuckets.count > 0) this.cache.conversionRate = convBuckets;
        }
      } catch {
        // Intelligence collection not available, keep defaults
      }
    }

    this.lastComputed = Date.now();

    try {
      await this.redis.set(REDIS_KEY, JSON.stringify(this.cache), 'EX', REDIS_TTL);
    } catch {
      // Redis write failed, local cache still valid
    }

    return this.cache;
  }

  private extractBuckets(facetResult: any[]): PercentileBuckets {
    if (!facetResult?.[0]?.values?.length) {
      return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, count: 0 };
    }

    const values = facetResult[0].values;
    const n = values.length;

    return {
      p10: values[Math.floor(n * 0.10)] ?? 0,
      p25: values[Math.floor(n * 0.25)] ?? 0,
      p50: values[Math.floor(n * 0.50)] ?? 0,
      p75: values[Math.floor(n * 0.75)] ?? 0,
      p90: values[Math.floor(n * 0.90)] ?? 0,
      count: n,
    };
  }
}

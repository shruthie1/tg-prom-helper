/**
 * Percentile Engine — computes dynamic thresholds from activeChannels collection.
 *
 * Cached in Redis (cross-process sharing) and in-memory (per-process).
 * Both promote-clients and tg-aut read the same Redis cache.
 * Refreshes every 30 minutes.
 */

import type { ChannelPercentiles, PercentileBuckets } from '../../types';
import type { AggregateableCollectionLike, RedisLike } from '../../types';

const REDIS_KEY = 'percentiles:channels';
const REDIS_TTL = 3600; // 1 hour
const REFRESH_MS = 30 * 60 * 1000; // 30 minutes
const METRICS = [
  'successRate',
  'deleteRate',
  'participantsCount',
  'deletedCount',
  'messageVolume',
  'followupSurvivalRate',
  'conversionRate',
  'saturationRate',
] as const satisfies readonly (keyof ChannelPercentiles)[];

export class PercentileEngine {
  private static instance: PercentileEngine | undefined;

  private cache: ChannelPercentiles | null = null;
  private lastComputed = 0;

  constructor(
    private activeChannelCollection: AggregateableCollectionLike,
    private redis: RedisLike,
    private intelligenceCollection: AggregateableCollectionLike | undefined = undefined,
  ) {
    if (!isAggregateableCollectionLike(activeChannelCollection)) {
      throw new Error('PercentileEngine active channel collection is required');
    }
    if (!isRedisLike(redis)) {
      throw new Error('PercentileEngine redis client is required');
    }
    if (intelligenceCollection !== undefined && !isAggregateableCollectionLike(intelligenceCollection)) {
      throw new Error('PercentileEngine intelligence collection must support aggregate');
    }
  }

  static init(
    collection: AggregateableCollectionLike,
    redis: RedisLike,
    intelligenceCollection?: AggregateableCollectionLike,
    options: { replace?: boolean } = {},
  ): PercentileEngine {
    if (!PercentileEngine.instance || shouldReplace(options)) {
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

  static reset(): void {
    PercentileEngine.instance = undefined;
  }

  async getPercentiles(): Promise<ChannelPercentiles> {
    if (this.cache && Date.now() - this.lastComputed < REFRESH_MS) {
      return this.cache;
    }

    // Try Redis first (cross-process sharing)
    try {
      const cached = await this.redis.get(REDIS_KEY);
      if (cached) {
        const parsed = parsePercentiles(JSON.parse(cached));
        if (parsed) {
          this.cache = parsed;
          this.lastComputed = Date.now();
          return parsed;
        }
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
    const p = sanitizeBuckets(this.cache?.[metric]);
    if (!p || p.count === 0) return 0.5;
    return this.computeRank(value, p);
  }

  private computeRank(value: number, p: PercentileBuckets): number {
    const buckets = sanitizeBuckets(p);
    if (!buckets || buckets.count === 0) return 0.5;
    if (!Number.isFinite(value)) return 0.5;
    let rank: number;
    if (value <= buckets.p10) {
      rank = 0.05 + 0.05 * (value / Math.max(0.001, buckets.p10));
    } else if (value <= buckets.p25) {
      rank = 0.10 + 0.15 * ((value - buckets.p10) / Math.max(0.001, buckets.p25 - buckets.p10));
    } else if (value <= buckets.p50) {
      rank = 0.25 + 0.25 * ((value - buckets.p25) / Math.max(0.001, buckets.p50 - buckets.p25));
    } else if (value <= buckets.p75) {
      rank = 0.50 + 0.25 * ((value - buckets.p50) / Math.max(0.001, buckets.p75 - buckets.p50));
    } else if (value <= buckets.p90) {
      rank = 0.75 + 0.15 * ((value - buckets.p75) / Math.max(0.001, buckets.p90 - buckets.p75));
    } else {
      rank = 0.90 + 0.10 * Math.min(1, (value - buckets.p90) / Math.max(0.001, buckets.p90 - buckets.p75));
    }
    return Math.max(0, Math.min(1, rank));
  }

  private async computeAndCache(): Promise<ChannelPercentiles> {
    const pipeline = [
      { $match: { banned: { $ne: true }, forbidden: { $ne: true } } },
      {
        $addFields: {
          _safeSuccess: safeMongoNumber('$successMsgCount'),
          _safeFailure: safeMongoNumber('$failureMsgCount'),
          _safeDeleted: safeMongoNumber('$deletedCount'),
          _safeParticipants: safeMongoNumber('$participantsCount'),
          _safeFollowupSuccess: safeMongoNumber('$followupMsgSuccessCount'),
        },
      },
      {
        $addFields: {
          _totalAttempts: {
            $add: ['$_safeSuccess', '$_safeFailure'],
          },
          _successRate: {
            $cond: [
              {
                $gt: [{ $add: ['$_safeSuccess', '$_safeFailure'] }, 4],
              },
              {
                $divide: [
                  '$_safeSuccess',
                  { $add: ['$_safeSuccess', '$_safeFailure'] },
                ],
              },
              null,
            ],
          },
          _deleteRate: {
            $cond: [
              { $gt: ['$_safeSuccess', 0] },
              {
                $divide: [
                  '$_safeDeleted',
                  '$_safeSuccess',
                ],
              },
              null,
            ],
          },
          _saturation: {
            $cond: [
              {
                $and: [
                  { $gt: ['$_safeSuccess', 0] },
                  { $gt: ['$_safeParticipants', 0] },
                ],
              },
              {
                $divide: [
                  { $add: ['$_safeSuccess', '$_safeFollowupSuccess'] },
                  '$_safeParticipants',
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
            { $match: { _safeParticipants: { $gt: 0 } } },
            { $sort: { _safeParticipants: 1 } },
            { $group: { _id: null, values: { $push: '$_safeParticipants' }, count: { $sum: 1 } } },
          ],
          deletedCountValues: [
            { $sort: { _safeDeleted: 1 } },
            { $group: { _id: null, values: { $push: '$_safeDeleted' }, count: { $sum: 1 } } },
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

    let result: Record<string, unknown> = {};
    try {
      const activeResults = await this.activeChannelCollection.aggregate(pipeline).toArray();
      const firstResult = Array.isArray(activeResults) ? activeResults[0] : null;
      result = isRecord(firstResult) ? firstResult : {};
    } catch {
      // Active channel aggregation unavailable, keep safe default buckets.
    }

    this.cache = {
      successRate: this.extractBuckets(result['successRateValues']),
      deleteRate: this.extractBuckets(result['deleteRateValues']),
      participantsCount: this.extractBuckets(result['participantsValues']),
      deletedCount: this.extractBuckets(result['deletedCountValues']),
      messageVolume: this.extractBuckets(result['messageVolumeValues']),
      saturationRate: this.extractBuckets(result['saturationValues']),
      followupSurvivalRate: { p10: 0, p25: 0.2, p50: 0.5, p75: 0.7, p90: 0.9, count: 0 },
      conversionRate: { p10: 0, p25: 0, p50: 0, p75: 0.01, p90: 0.05, count: 0 },
    };

    // Compute followupSurvivalRate and conversionRate from intelligence collection
    if (this.intelligenceCollection) {
      try {
        const [intelResult] = await this.intelligenceCollection.aggregate([
          {
            $addFields: {
              _safeFollowupTotal: safeMongoNumber('$followupTotal'),
              _safeFollowupSuccess: safeMongoNumber('$followupSuccessCount'),
              _safeConversions: safeMongoNumber('$conversions'),
              _safeTotalSends: safeMongoNumber('$totalSendsToChannel'),
            },
          },
          {
            $facet: {
              followupRateValues: [
                { $match: { _safeFollowupTotal: { $gt: 4 } } },
                { $addFields: { _fuRate: { $divide: ['$_safeFollowupSuccess', '$_safeFollowupTotal'] } } },
                { $sort: { _fuRate: 1 } },
                { $group: { _id: null, values: { $push: '$_fuRate' }, count: { $sum: 1 } } },
              ],
              conversionRateValues: [
                { $match: { _safeConversions: { $gt: 0 }, _safeTotalSends: { $gt: 0 } } },
                { $addFields: { _convRate: { $divide: ['$_safeConversions', '$_safeTotalSends'] } } },
                { $sort: { _convRate: 1 } },
                { $group: { _id: null, values: { $push: '$_convRate' }, count: { $sum: 1 } } },
              ],
            },
          },
        ]).toArray();

        if (intelResult) {
          const fuBuckets = this.extractBuckets(intelResult['followupRateValues']);
          if (fuBuckets.count > 0) this.cache.followupSurvivalRate = fuBuckets;
          const convBuckets = this.extractBuckets(intelResult['conversionRateValues']);
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

  private extractBuckets(facetResult: unknown): PercentileBuckets {
    if (!Array.isArray(facetResult)) {
      return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, count: 0 };
    }
    const firstFacet = facetResult[0];
    if (!isRecord(firstFacet) || !Array.isArray(firstFacet['values']) || firstFacet['values'].length === 0) {
      return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, count: 0 };
    }

    const values = firstFacet['values']
      .filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((a: number, b: number) => a - b);
    const n = values.length;
    if (n === 0) {
      return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, count: 0 };
    }

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

function parsePercentiles(value: unknown): ChannelPercentiles | null {
  if (!isRecord(value)) return null;
  const parsed: Partial<ChannelPercentiles> = {};
  for (const metric of METRICS) {
    const buckets = sanitizeBuckets(value[metric]);
    if (!buckets) return null;
    parsed[metric] = buckets;
  }
  return parsed as ChannelPercentiles;
}

function sanitizeBuckets(value: unknown): PercentileBuckets | null {
  if (!isRecord(value)) return null;
  const raw = [
    safeNumber(value['p10']),
    safeNumber(value['p25']),
    safeNumber(value['p50']),
    safeNumber(value['p75']),
    safeNumber(value['p90']),
  ];
  if (raw.some(item => item === null)) return null;
  let previous = 0;
  const ordered = raw.map((item) => {
    const next = Math.max(previous, item ?? 0);
    previous = next;
    return next;
  });
  const count = Math.max(0, Math.floor(safeNumber(value['count']) ?? 0));
  return {
    p10: ordered[0] ?? 0,
    p25: ordered[1] ?? 0,
    p50: ordered[2] ?? 0,
    p75: ordered[3] ?? 0,
    p90: ordered[4] ?? 0,
    count,
  };
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeMongoNumber(input: string): Record<string, unknown> {
  return {
    $max: [
      0,
      {
        $convert: {
          input,
          to: 'double',
          onError: 0,
          onNull: 0,
        },
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAggregateableCollectionLike(value: unknown): value is AggregateableCollectionLike {
  return isRecord(value) && typeof value['aggregate'] === 'function';
}

function isRedisLike(value: unknown): value is RedisLike {
  return isRecord(value)
    && typeof value['get'] === 'function'
    && typeof value['set'] === 'function';
}

function shouldReplace(options: unknown): boolean {
  return isRecord(options) && options['replace'] === true;
}

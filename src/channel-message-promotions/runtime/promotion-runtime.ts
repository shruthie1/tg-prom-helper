import { ChannelIntelligenceService } from '../channel-intelligence/channel-intelligence-service';
import { PercentileEngine } from '../channel-intelligence/percentile-engine';
import { ConversionAttributionService } from '../attribution/conversion-attribution';
import { RedisChannelLock } from '../redis/redis-channel-lock';
import { RedisPromotionTracker } from '../redis/redis-promotion-tracker';
import type {
  AggregateableCollectionLike,
  MongoCollectionLike,
  RedisLike,
} from '../../types';
import type { ChannelIntelligenceDocument, MessageStrategy } from '../channel-intelligence';
import { normalizeChannelId } from '../utils/channel-id';

export interface PromotionRuntimeOptions {
  channelIntelligenceCollection: MongoCollectionLike<ChannelIntelligenceDocument> & AggregateableCollectionLike;
  activeChannelCollection?: AggregateableCollectionLike;
  redis?: RedisLike | null;
  enablePercentiles?: boolean;
  enableLocks?: boolean;
  enableAttribution?: boolean;
  warmPercentiles?: boolean;
}

export interface PromotionAccountContextOptions {
  mobile: string;
  clientId: string;
}

export class PromotionAccountContext {
  constructor(
    private readonly runtime: PromotionRuntime,
    readonly mobile: string,
    readonly clientId: string,
  ) {}

  get intelligence(): ChannelIntelligenceService {
    return this.runtime.intelligence;
  }

  async recordSend(channelId: string): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (this.runtime.tracker && safeChannelId) {
      await this.runtime.tracker.recordSend(safeChannelId, this.mobile, this.clientId);
    }
  }

  async markPromoted(channelId: string): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (this.runtime.channelLock && safeChannelId) {
      await this.runtime.channelLock.markPromoted(safeChannelId, this.mobile);
    }
  }

  async isRecentlyPromoted(channelId: string): Promise<boolean> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return false;
    return this.runtime.channelLock
      ? this.runtime.channelLock.isRecentlyPromoted(safeChannelId)
      : false;
  }

  async recordSuccess(channelId: string, strategy: MessageStrategy, isFollowup: boolean): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    await this.runtime.intelligence.recordSuccess(safeChannelId, strategy, isFollowup);
  }

  async recordDeletion(
    channelId: string,
    strategy: MessageStrategy,
    survivalMs: number,
    isFollowup: boolean,
  ): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    await this.runtime.intelligence.recordDeletion(safeChannelId, strategy, survivalMs, isFollowup);
  }

  async recordFailure(channelId: string, strategy: MessageStrategy, errorType: string): Promise<void> {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return;
    await this.runtime.intelligence.recordFailure(safeChannelId, strategy, errorType);
  }
}

export class PromotionRuntime {
  private static instance: PromotionRuntime | null = null;

  readonly intelligence: ChannelIntelligenceService;
  readonly percentiles: PercentileEngine | null;
  readonly channelLock: RedisChannelLock | null;
  readonly tracker: RedisPromotionTracker | null;
  readonly attribution: ConversionAttributionService | null;

  private constructor(params: {
    intelligence: ChannelIntelligenceService;
    percentiles: PercentileEngine | null;
    channelLock: RedisChannelLock | null;
    tracker: RedisPromotionTracker | null;
    attribution: ConversionAttributionService | null;
  }) {
    this.intelligence = params.intelligence;
    this.percentiles = params.percentiles;
    this.channelLock = params.channelLock;
    this.tracker = params.tracker;
    this.attribution = params.attribution;
  }

  static async create(options: PromotionRuntimeOptions): Promise<PromotionRuntime> {
    const safeOptions = asRecord(options);
    const channelIntelligenceCollection = safeOptions['channelIntelligenceCollection'];
    if (!isCollectionLike(channelIntelligenceCollection)) {
      throw new Error('PromotionRuntime channelIntelligenceCollection is required');
    }
    const replace = true;
    const intelligence = ChannelIntelligenceService.init(channelIntelligenceCollection, { replace });
    await intelligence.ensureIndexes();

    const redisCandidate = safeOptions['redis'];
    const percentileRedis = isPercentileRedisLike(redisCandidate) ? redisCandidate as RedisLike : null;
    const lockRedis = isLockRedisLike(redisCandidate) ? redisCandidate as RedisLike : null;
    const trackerRedis = isTrackerRedisLike(redisCandidate) ? redisCandidate as RedisLike : null;
    const activeChannelCollection = isAggregateableCollectionLike(safeOptions['activeChannelCollection'])
      ? safeOptions['activeChannelCollection']
      : undefined;
    const usePercentiles = percentileRedis !== null && safeOptions['enablePercentiles'] !== false && !!activeChannelCollection;
    const useLocks = lockRedis !== null && safeOptions['enableLocks'] === true;
    const useAttribution = trackerRedis !== null && safeOptions['enableAttribution'] === true;
    if (safeOptions['enableLocks'] === true && !useLocks) {
      throw new Error('PromotionRuntime Redis channel locks require a Redis client with get/set/exists');
    }
    if (safeOptions['enableAttribution'] === true && !useAttribution) {
      throw new Error('PromotionRuntime conversion attribution requires a Redis client with get/set/lrange/pipeline');
    }

    const percentiles = usePercentiles && activeChannelCollection
      ? PercentileEngine.init(
        activeChannelCollection,
        percentileRedis,
        channelIntelligenceCollection,
        { replace },
      )
      : (PercentileEngine.reset(), null);

    const channelLock = useLocks
      ? RedisChannelLock.init(lockRedis, { replace })
      : (RedisChannelLock.reset(), null);
    const tracker = useAttribution
      ? RedisPromotionTracker.init(trackerRedis, { replace })
      : (RedisPromotionTracker.reset(), null);
    const attribution = tracker
      ? ConversionAttributionService.init(intelligence, tracker, { replace })
      : (ConversionAttributionService.reset(), null);

    if (percentiles && safeOptions['warmPercentiles'] !== false) {
      await percentiles.getPercentiles();
    }

    const runtime = new PromotionRuntime({
      intelligence,
      percentiles,
      channelLock,
      tracker,
      attribution,
    });
    PromotionRuntime.instance = runtime;
    return runtime;
  }

  static getInstance(): PromotionRuntime {
    if (!PromotionRuntime.instance) {
      throw new Error('PromotionRuntime not initialized. Call createPromotionRuntime() first.');
    }
    return PromotionRuntime.instance;
  }

  static reset(): void {
    PromotionRuntime.instance = null;
    ChannelIntelligenceService.reset();
    PercentileEngine.reset();
    RedisChannelLock.reset();
    RedisPromotionTracker.reset();
    ConversionAttributionService.reset();
  }

  createAccountContext(options: PromotionAccountContextOptions): PromotionAccountContext {
    const safeOptions = asRecord(options);
    const mobile = requireIdentity(safeOptions['mobile'], 'mobile');
    const clientId = requireIdentity(safeOptions['clientId'], 'clientId');
    return new PromotionAccountContext(this, mobile, clientId);
  }
}

export async function createPromotionRuntime(options: PromotionRuntimeOptions): Promise<PromotionRuntime> {
  return PromotionRuntime.create(options);
}

function requireIdentity(value: unknown, field: string): string {
  const normalized = normalizeIdentity(value);
  if (!normalized) throw new Error(`Promotion account ${field} is required`);
  return normalized;
}

function normalizeIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isCollectionLike(value: unknown): value is MongoCollectionLike<ChannelIntelligenceDocument> & AggregateableCollectionLike {
  return isRecord(value)
    && typeof value['findOne'] === 'function'
    && typeof value['find'] === 'function'
    && typeof value['findOneAndUpdate'] === 'function'
    && typeof value['updateOne'] === 'function'
    && typeof value['createIndex'] === 'function'
    && typeof value['aggregate'] === 'function';
}

function isAggregateableCollectionLike(value: unknown): value is AggregateableCollectionLike {
  return isRecord(value) && typeof value['aggregate'] === 'function';
}

function isPercentileRedisLike(value: unknown): boolean {
  return isRecord(value)
    && typeof value['get'] === 'function'
    && typeof value['set'] === 'function';
}

function isLockRedisLike(value: unknown): boolean {
  return isRecord(value)
    && typeof value['get'] === 'function'
    && typeof value['set'] === 'function'
    && typeof value['exists'] === 'function';
}

function isTrackerRedisLike(value: unknown): boolean {
  if (
    !isRecord(value)
    || typeof value['get'] !== 'function'
    || typeof value['set'] !== 'function'
    || typeof value['lrange'] !== 'function'
    || typeof value['pipeline'] !== 'function'
  ) {
    return false;
  }
  try {
    return isTrackerPipelineLike(value['pipeline']());
  } catch {
    return false;
  }
}

function isTrackerPipelineLike(value: unknown): boolean {
  return isRecord(value)
    && typeof value['lpush'] === 'function'
    && typeof value['ltrim'] === 'function'
    && typeof value['expire'] === 'function'
    && typeof value['set'] === 'function'
    && typeof value['exec'] === 'function';
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

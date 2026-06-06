import packageJson from '../package.json';
import * as publicApi from '../src';
import {
  ChannelIntelligenceService,
  ConversionAttributionService,
  DiscountedThompsonSampling,
  ChannelClassifier,
  PromotionFlowRunner,
  PromotionMessageQueue,
  PromotionRunnerSupervisor,
  PromotionRuntime,
  PercentileEngine,
  RedisChannelLock,
  RedisPromotionTracker,
  calculatePromotionBatchLimit,
  createPromotionRuntime,
  computeExpectedValue,
  createDefaultIntelligence,
  classifyTelegramChannelError,
  computeLiveCanSendMsgs,
  evaluateDeletionPolicy,
  evaluateFollowUpScheduling,
  evaluateChannelPromotionHealth,
  evaluatePromotionChannelEligibility,
  getTelegramChannelLiveFacts,
  getTelegramChannelMessageStats,
  getTelegramCommonChatIds,
  mergeHydratedChannelFacts,
  readPromotionFeatureFlags,
  resolvePromotionFailureAction,
  selectPromotionChannels,
  shouldHydrateBeforeFinalReject,
} from '../src';
import type {
  ChannelPercentiles,
  CommonChatId,
  MongoCollectionLike,
  PromotionFeatureFlags,
  PromotionFlowAdapter,
  PromotionFlowRunnerOptions,
  PromotionFlowStats,
  PromotionMessageCheckResult,
  PromotionQueuedMessage,
  PromotionRunnerHealthSnapshot,
  PromotionRunnerSupervisorHealth,
  PromotionRunnerSupervisorOptions,
  PromotionRuntimeOptions,
  PromotionSendResult,
  RedisExistsResult,
  RedisLike,
  RedisPipelineLike,
} from '../src';

describe('public package API', () => {
  it('exports the main runtime, policy, selection, and helper surfaces from root', () => {
    expect(ChannelIntelligenceService).toBeDefined();
    expect(ChannelClassifier).toBeDefined();
    expect(ConversionAttributionService).toBeDefined();
    expect(DiscountedThompsonSampling).toBeDefined();
    expect(PercentileEngine).toBeDefined();
    expect(PromotionFlowRunner).toBeDefined();
    expect(PromotionMessageQueue).toBeDefined();
    expect(PromotionRunnerSupervisor).toBeDefined();
    expect(PromotionRuntime).toBeDefined();
    expect(RedisChannelLock).toBeDefined();
    expect(RedisPromotionTracker).toBeDefined();
    expect(calculatePromotionBatchLimit).toBeDefined();
    expect(createPromotionRuntime).toBeDefined();
    expect(computeExpectedValue).toBeDefined();
    expect(createDefaultIntelligence).toBeDefined();
    expect(classifyTelegramChannelError).toBeDefined();
    expect(computeLiveCanSendMsgs).toBeDefined();
    expect(evaluateDeletionPolicy).toBeDefined();
    expect(evaluateFollowUpScheduling).toBeDefined();
    expect(evaluateChannelPromotionHealth).toBeDefined();
    expect(evaluatePromotionChannelEligibility).toBeDefined();
    expect(getTelegramChannelLiveFacts).toBeDefined();
    expect(getTelegramChannelMessageStats).toBeDefined();
    expect(getTelegramCommonChatIds).toBeDefined();
    expect(mergeHydratedChannelFacts).toBeDefined();
    expect(readPromotionFeatureFlags).toBeDefined();
    expect(resolvePromotionFailureAction).toBeDefined();
    expect(selectPromotionChannels).toBeDefined();
    expect(shouldHydrateBeforeFinalReject).toBeDefined();
  });

  it('keeps npm subpath exports aligned with supported package boundaries', () => {
    expect(packageJson.type).toBe('commonjs');
    expect(packageJson.sideEffects).toBe(false);
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
    expect(packageJson.files).toEqual(['dist']);
    expect(Object.keys(packageJson.exports)).toEqual(['.']);
    expect(packageJson.exports['.']).toEqual({
      types: './dist/index.d.ts',
      require: './dist/index.js',
    });
  });

  it('does not expose internal sanitization helpers from the root API', () => {
    expect(publicApi).not.toHaveProperty('safeUnitRandom');
    expect(publicApi).not.toHaveProperty('safeSessionRate');
    expect(publicApi).not.toHaveProperty('safeNonNegative');
    expect(publicApi).not.toHaveProperty('parsePercentiles');
    expect(publicApi).not.toHaveProperty('sanitizeBuckets');
    expect(publicApi).not.toHaveProperty('normalizeIdentity');
    expect(publicApi).not.toHaveProperty('requireIdentity');
    expect(publicApi).not.toHaveProperty('normalizeCommonChatIds');
    expect(publicApi).not.toHaveProperty('normalizeLastPromoter');
    expect(publicApi).not.toHaveProperty('normalizeSendRecord');
    expect(publicApi).not.toHaveProperty('normalizeChannelId');
    expect(publicApi).not.toHaveProperty('normalizeChannelIds');
    expect(publicApi).not.toHaveProperty('normalizeQueuedMessage');
    expect(publicApi).not.toHaveProperty('normalizeStrategies');
    expect(publicApi).not.toHaveProperty('normalizeLimit');
    expect(publicApi).not.toHaveProperty('normalizeStats');
    expect(publicApi).not.toHaveProperty('normalizeMessageCheckResult');
    expect(publicApi).not.toHaveProperty('normalizeSendResult');
    expect(publicApi).not.toHaveProperty('normalizeChannels');
    expect(publicApi).not.toHaveProperty('normalizeKeyPart');
    expect(publicApi).not.toHaveProperty('normalizeErrorType');
    expect(publicApi).not.toHaveProperty('normalizeMessageIndex');
    expect(publicApi).not.toHaveProperty('normalizeMessageStrategy');
    expect(publicApi).not.toHaveProperty('safeElapsedMs');
    expect(publicApi).not.toHaveProperty('safeNonNegativeInput');
    expect(publicApi).not.toHaveProperty('safePercentileRank');
    expect(publicApi).not.toHaveProperty('safeRank');
    expect(publicApi).not.toHaveProperty('asString');
    expect(publicApi).not.toHaveProperty('asRecord');
    expect(publicApi).not.toHaveProperty('getStrategyEntries');
    expect(publicApi).not.toHaveProperty('safeText');
    expect(publicApi).not.toHaveProperty('normalizeLabel');
    expect(publicApi).not.toHaveProperty('isMessageStrategy');
    expect(publicApi).not.toHaveProperty('isChannelIntelligenceDocument');
    expect(publicApi).not.toHaveProperty('shouldProcessNextChannel');
    expect(publicApi).not.toHaveProperty('isAdapterLike');
    expect(publicApi).not.toHaveProperty('isAccountLike');
    expect(publicApi).not.toHaveProperty('isBanditLike');
    expect(publicApi).not.toHaveProperty('isMessageQueueLike');
    expect(publicApi).not.toHaveProperty('isCollectionLike');
    expect(publicApi).not.toHaveProperty('isRedisLike');
    expect(publicApi).not.toHaveProperty('isAggregateableCollectionLike');
    expect(publicApi).not.toHaveProperty('shouldReplace');
    expect(publicApi).not.toHaveProperty('isTrackerLike');
    expect(publicApi).not.toHaveProperty('isIntelligenceServiceLike');
    expect(publicApi).not.toHaveProperty('isArmState');
    expect(publicApi).not.toHaveProperty('isSerializedArmState');
    expect(publicApi).not.toHaveProperty('fallbackStrategy');
    expect(publicApi).not.toHaveProperty('safeArms');
    expect(publicApi).not.toHaveProperty('ReadyMessage');
    expect(publicApi).not.toHaveProperty('normalizeReadyMessages');
    expect(publicApi).not.toHaveProperty('normalizeReadyMessage');
    expect(publicApi).not.toHaveProperty('normalizeRedisList');
    expect(publicApi).not.toHaveProperty('isRedisPipelineLike');
    expect(publicApi).not.toHaveProperty('normalizeText');
    expect(publicApi).not.toHaveProperty('readCursorArray');
    expect(publicApi).not.toHaveProperty('isCursorToArrayLike');
    expect(publicApi).not.toHaveProperty('isSortableCursorLike');
  });

  it('exposes shared structural types from the types barrel', () => {
    const percentiles: ChannelPercentiles | null = null;
    const collection: MongoCollectionLike<unknown> | null = null;
    const redis: RedisLike | null = null;
    const redisExists: RedisExistsResult = true;
    const commonChatId: CommonChatId = BigInt(-100123);

    expect(percentiles).toBeNull();
    expect(collection).toBeNull();
    expect(redis).toBeNull();
    expect(redisExists).toBe(true);
    expect(commonChatId).toBe(BigInt(-100123));
  });

  it('types compatible Redis exists responses used by common Redis wrappers', async () => {
    let pipeline: RedisPipelineLike;
    pipeline = {
      lpush: () => pipeline,
      ltrim: () => pipeline,
      expire: () => pipeline,
      set: () => pipeline,
      exec: async () => undefined,
    };
    const booleanExistsRedis: RedisLike = {
      get: async () => null,
      set: async () => 'OK',
      exists: async () => true,
      lrange: async () => [],
      pipeline: () => pipeline,
    };

    await expect(booleanExistsRedis.exists('lock')).resolves.toBe(true);
  });

  it('exposes consumer-facing runtime and runner type contracts from root', () => {
    const stats: PromotionFlowStats = { successCount: 1, failedCount: 0, failStreak: 0, daysLeft: 2 };
    const check: PromotionMessageCheckResult = { status: 'unknown' };
    const send: PromotionSendResult = { sent: false, messageIndex: '0', terminal: true };
    const queued: PromotionQueuedMessage = {
      channelId: 'ch-public',
      messageId: 1,
      timestamp: 0,
      messageIndex: '0',
      isFollowUp: false,
    };
    const flags: PromotionFeatureFlags = {
      channelScoring: true,
      messageBandit: true,
      redisChannelLock: false,
      conversionAttribution: false,
      runtimeRequired: true,
    };
    const runtimeOptions: PromotionRuntimeOptions | null = null;
    const runnerOptions: PromotionFlowRunnerOptions | null = null;
    const runnerHealth: PromotionRunnerHealthSnapshot | null = null;
    const supervisorHealth: PromotionRunnerSupervisorHealth | null = null;
    const supervisorOptions: PromotionRunnerSupervisorOptions<any> | null = null;
    const adapter: PromotionFlowAdapter<any> | null = null;

    expect(stats.successCount).toBe(1);
    expect(check.status).toBe('unknown');
    expect(send.terminal).toBe(true);
    expect(queued.channelId).toBe('ch-public');
    expect(flags.channelScoring).toBe(true);
    expect(runtimeOptions).toBeNull();
    expect(runnerOptions).toBeNull();
    expect(runnerHealth).toBeNull();
    expect(supervisorHealth).toBeNull();
    expect(supervisorOptions).toBeNull();
    expect(adapter).toBeNull();
  });
});

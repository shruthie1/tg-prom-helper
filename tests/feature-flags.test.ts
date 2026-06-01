import { readPromotionFeatureFlags } from '../src';

describe('readPromotionFeatureFlags', () => {
  it('keeps runtime optional when all helper-backed features are disabled or absent', () => {
    expect(readPromotionFeatureFlags({})).toEqual({
      channelScoring: false,
      conversionAttribution: false,
      redisChannelLock: false,
      messageBandit: false,
      runtimeRequired: false,
    });

    expect(readPromotionFeatureFlags({
      ENABLE_CHANNEL_SCORING: 'false',
      ENABLE_CONVERSION_ATTRIBUTION: 'false',
      ENABLE_REDIS_CHANNEL_LOCK: 'false',
      ENABLE_MESSAGE_BANDIT: 'false',
    }).runtimeRequired).toBe(false);
  });

  it('requires runtime when any helper-backed feature is enabled', () => {
    expect(readPromotionFeatureFlags({ ENABLE_CHANNEL_SCORING: 'true' }).runtimeRequired).toBe(true);
    expect(readPromotionFeatureFlags({ ENABLE_CONVERSION_ATTRIBUTION: 'true' }).runtimeRequired).toBe(true);
    expect(readPromotionFeatureFlags({ ENABLE_REDIS_CHANNEL_LOCK: 'true' }).runtimeRequired).toBe(true);
    expect(readPromotionFeatureFlags({ ENABLE_MESSAGE_BANDIT: 'true' }).runtimeRequired).toBe(true);
  });

  it('keeps legacy exact true semantics for existing env flags', () => {
    expect(readPromotionFeatureFlags({ ENABLE_CHANNEL_SCORING: 'TRUE' }).channelScoring).toBe(false);
    expect(readPromotionFeatureFlags({ ENABLE_CHANNEL_SCORING: '1' }).channelScoring).toBe(false);
    expect(readPromotionFeatureFlags({ ENABLE_CHANNEL_SCORING: 'true' }).channelScoring).toBe(true);
  });

  it('accepts process-env-shaped objects', () => {
    const env: NodeJS.ProcessEnv = {
      ENABLE_CHANNEL_SCORING: 'false',
      ENABLE_CONVERSION_ATTRIBUTION: 'true',
    };

    expect(readPromotionFeatureFlags(env)).toEqual({
      channelScoring: false,
      conversionAttribution: true,
      redisChannelLock: false,
      messageBandit: false,
      runtimeRequired: true,
    });
  });

  it('treats malformed env inputs as all-disabled for JavaScript callers', () => {
    expect(readPromotionFeatureFlags(null as unknown as Record<string, string | undefined>)).toEqual({
      channelScoring: false,
      conversionAttribution: false,
      redisChannelLock: false,
      messageBandit: false,
      runtimeRequired: false,
    });

    expect(readPromotionFeatureFlags({
      ENABLE_CHANNEL_SCORING: true as unknown as string,
      ENABLE_CONVERSION_ATTRIBUTION: 1 as unknown as string,
      ENABLE_REDIS_CHANNEL_LOCK: 'true',
    })).toEqual({
      channelScoring: false,
      conversionAttribution: false,
      redisChannelLock: true,
      messageBandit: false,
      runtimeRequired: true,
    });
  });
});

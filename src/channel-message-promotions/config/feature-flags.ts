export type PromotionFeatureEnv = Readonly<Record<string, string | undefined> & {
  ENABLE_CHANNEL_SCORING?: string;
  ENABLE_CONVERSION_ATTRIBUTION?: string;
  ENABLE_REDIS_CHANNEL_LOCK?: string;
  ENABLE_MESSAGE_BANDIT?: string;
}>;

export interface PromotionFeatureFlags {
  channelScoring: boolean;
  conversionAttribution: boolean;
  redisChannelLock: boolean;
  messageBandit: boolean;
  runtimeRequired: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === 'true';
}

export function readPromotionFeatureFlags(env: PromotionFeatureEnv): PromotionFeatureFlags {
  const source = isRecord(env) ? env : {};
  const flags = {
    channelScoring: enabled(asString(source['ENABLE_CHANNEL_SCORING'])),
    conversionAttribution: enabled(asString(source['ENABLE_CONVERSION_ATTRIBUTION'])),
    redisChannelLock: enabled(asString(source['ENABLE_REDIS_CHANNEL_LOCK'])),
    messageBandit: enabled(asString(source['ENABLE_MESSAGE_BANDIT'])),
  };

  return {
    ...flags,
    runtimeRequired: flags.channelScoring
      || flags.conversionAttribution
      || flags.redisChannelLock
    || flags.messageBandit,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

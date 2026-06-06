import type { MessageStrategy } from '../channel-intelligence';

export interface PromotionChannelSnapshot {
  channelId: string;
  title?: string;
  username?: string | null;
  participantsCount?: number | null;
  banned?: boolean;
  bannedAt?: number | Date | null;
  restricted?: boolean;
  forbidden?: boolean;
  private?: boolean;
  broadcast?: boolean;
  sendMessages?: boolean;
  sendPlain?: boolean;
  canSendMsgs?: boolean;
  deletedCount?: number | null;
  successMsgCount?: number | null;
  failureMsgCount?: number | null;
  wordRestriction?: number | null;
  dMRestriction?: number | null;
  recentUniqueUsers?: number | null;
  lastUniqueUserCheckAt?: number | Date | null;
  availableMsgs?: string[];
}

export interface PreviousPromotionResultSnapshot {
  success: boolean;
  errorMessage?: string;
  lastCheckTimestamp: number;
}

export interface PercentileRankProvider {
  getPercentileRankSync(value: number, metric: string): number;
}

export interface ChannelClassificationSnapshot {
  category?: string;
  confidence?: number;
}

export interface ChannelEligibilityInput {
  channel: PromotionChannelSnapshot;
  scoringEnabled: boolean;
  now?: number;
  previousResult?: PreviousPromotionResultSnapshot | null;
  recentlyQueued?: boolean;
  recentlyPromotedByOtherAccount?: boolean;
  percentiles?: PercentileRankProvider | null;
  classification?: ChannelClassificationSnapshot | null;
  random?: () => number;
}

export interface ChannelEligibilityResult {
  eligible: boolean;
  reason: string | null;
}

export interface BatchLimitInput {
  scoringEnabled: boolean;
  daysLeft: number;
  successCount: number;
  failedCount: number;
  failStreak: number;
  random?: () => number;
  includeJitter?: boolean;
}

export interface BatchLimitResult {
  limit: number;
  sessionRate: number;
  healthMultiplier: number | null;
}

export interface HealthDelayInput {
  successCount: number;
  failedCount: number;
  failStreak: number;
  random?: () => number;
}

export interface DelayResult {
  delayMs: number;
  sessionRate: number;
  mode: 'healthy' | 'degraded' | 'normal';
}

export type PromotionMessageKind = 'ai' | 'custom' | 'legacy' | 'followUp' | 'fallback';

export interface PromotionMessageCandidate {
  kind: PromotionMessageKind;
  randomIndex: string;
  strategy: MessageStrategy | null;
}

export interface MessagePolicyInput {
  isFollowUp: boolean;
  wordRestriction?: number | null;
  dMRestriction?: number | null;
  deletedCount?: number | null;
  failStreak: number;
  banditStrategy?: MessageStrategy | null;
  availableMessageIds?: string[];
  random?: () => number;
}

export interface FollowUpPolicyInput {
  isFollowUp: boolean;
  daysLeft?: number;
  isCleanedUp?: boolean;
  channelAvailable?: boolean;
  activeFollowUpCount?: number;
  maxFollowUpCount?: number;
}

export interface FollowUpPolicyResult {
  shouldSchedule: boolean;
  reason: string | null;
}

export type DeletionAction =
  | 'increment_dm_restriction'
  | 'increment_word_restriction'
  | 'remove_message_index'
  | 'ban_no_available_messages';

export interface DeletionPolicyResult {
  strategy: MessageStrategy | null;
  actions: DeletionAction[];
}

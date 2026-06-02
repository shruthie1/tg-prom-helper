import type { ChannelIntelligenceDocument } from '../channel-intelligence';
import type { MessageStrategy } from '../channel-intelligence';
import type { DiscountedThompsonSampling } from '../message-strategy';
import type { PromotionChannelSnapshot, PromotionMessageCandidate, DeletionPolicyResult, PercentileRankProvider } from '../policy';
import type { PromotionAccountContext } from '../runtime';
import type { PromotionMessageQueue } from './promotion-message-queue';

export interface PromotionQueuedMessage {
  channelId: string;
  messageId: number;
  timestamp: number;
  messageIndex: string;
  strategy?: MessageStrategy;
  isFollowUp: boolean;
  availableMessageCount?: number;
  messageText?: string;
}

export interface PromotionFlowStats {
  successCount: number;
  failedCount: number;
  failStreak: number;
  daysLeft: number;
}

export interface PromotionSendRequest<TChannel extends PromotionChannelSnapshot> {
  channel: TChannel;
  candidate: PromotionMessageCandidate;
  isFollowUp: boolean;
}

export interface PromotionSendResult {
  sent: boolean;
  messageId?: number;
  messageIndex: string;
  errorMessage?: string;
  terminal?: boolean;
}

export interface PromotionMessageCheckResult {
  status: 'exists' | 'deleted' | 'unknown';
  messageText?: string;
}

export type PromotionRunnerStatus = 'idle' | 'running' | 'stopping' | 'stopped';

export interface PromotionRunnerHealthSnapshot {
  status: PromotionRunnerStatus;
  running: boolean;
  startedByStart: boolean;
  queueSize: number;
  createdAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
  lastCycleStartedAt: number | null;
  lastCycleFinishedAt: number | null;
  lastQueueCheckStartedAt: number | null;
  lastQueueCheckFinishedAt: number | null;
  lastSuccessfulSendAt: number | null;
  lastSendFailureAt: number | null;
  lastDeletionAt: number | null;
  lastFollowUpScheduledAt: number | null;
  lastFollowUpStartedAt: number | null;
  lastFollowUpFinishedAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  totalCycles: number;
  totalCycleFailures: number;
  totalQueueChecks: number;
  totalSuccessfulSends: number;
  totalSendFailures: number;
  totalDeletions: number;
  totalFollowUpsScheduled: number;
  consecutiveCycleFailures: number;
}

export interface PromotionFlowAdapter<TChannel extends PromotionChannelSnapshot> {
  isActive(): boolean | Promise<boolean>;
  getStats(): PromotionFlowStats | Promise<PromotionFlowStats>;
  loadChannels(): Promise<TChannel[]>;
  getChannel(channelId: string): Promise<TChannel | null>;
  getIntelligenceDocs(channelIds: string[]): Promise<ChannelIntelligenceDocument[]>;
  getIntelligenceDoc(channelId: string): Promise<ChannelIntelligenceDocument | null>;
  getPercentiles?(): PercentileRankProvider | null | Promise<PercentileRankProvider | null>;
  isRecentlyQueued?(channelId: string): boolean;
  sendPromotion(request: PromotionSendRequest<TChannel>): Promise<PromotionSendResult>;
  checkMessage(message: PromotionQueuedMessage): Promise<PromotionMessageCheckResult>;
  onSendSuccess?(channel: TChannel, result: PromotionSendResult, isFollowUp: boolean): Promise<void> | void;
  onSendFailure?(channel: TChannel, errorMessage: string, isFollowUp: boolean): Promise<void> | void;
  onMessageExisting?(message: PromotionQueuedMessage): Promise<void> | void;
  onMessageDeleted?(message: PromotionQueuedMessage, actions: DeletionPolicyResult): Promise<void> | void;
  onFollowUpScheduled?(message: PromotionQueuedMessage, delayMs: number): Promise<void> | void;
  shouldContinue?(): boolean | Promise<boolean>;
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  sleep?(ms: number): Promise<void>;
}

export interface PromotionFlowRunnerOptions {
  account: PromotionAccountContext;
  scoringEnabled: boolean;
  messageBanditEnabled: boolean;
  redisLockEnabled: boolean;
  attributionEnabled: boolean;
  batchTarget?: number;
  messageCheckDelayMs?: number;
  followUpDelayMs?: number;
  followUpJitterMs?: number;
  maxFollowUpCount?: number;
  channelLoopDelayMs?: number;
  messageCheckIntervalMs?: number;
  maxQueueSize?: number;
  messageQueue?: PromotionMessageQueue;
  bandit?: DiscountedThompsonSampling;
}

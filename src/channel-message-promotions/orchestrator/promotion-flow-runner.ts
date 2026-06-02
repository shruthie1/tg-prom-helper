import { type ChannelIntelligenceDocument, type MessageStrategy } from '../channel-intelligence';
import { DiscountedThompsonSampling, PROMOTION_MESSAGE_STRATEGIES, selectChannelStrategy } from '../message-strategy';
import { selectPromotionChannels, type ChannelSelectionResult } from '../selection';
import {
  calculateHealthBasedPromotionDelay,
  calculatePromotionBatchLimit,
  evaluatePromotionChannelEligibility,
  evaluateDeletionPolicy,
  evaluateFollowUpScheduling,
  calculateFollowUpDelay,
  selectPromotionMessageCandidates,
  messageIndexToStrategy,
  type DeletionPolicyResult,
  type MessagePolicyInput,
  type PromotionChannelSnapshot,
  type PromotionMessageCandidate,
} from '../policy';
import type {
  PromotionFlowAdapter,
  PromotionFlowRunnerOptions,
  PromotionFlowStats,
  PromotionMessageCheckResult,
  PromotionQueuedMessage,
  PromotionRunnerHealthSnapshot,
  PromotionRunnerStatus,
  PromotionSendResult,
} from './promotion-flow.types';
import { PromotionMessageQueue } from './promotion-message-queue';
import { normalizeChannelId } from '../utils/channel-id';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const FAILED_CHANNEL_RETRY_MIN_MS = 5_000;
const FAILED_CHANNEL_RETRY_MAX_MS = 10_000;
type PromotionHookStatus = 'ok' | 'off' | 'fail' | 'skipped';

interface ReadyMessage {
  message: PromotionQueuedMessage;
  original: PromotionQueuedMessage;
}

type ChannelProcessOutcome = 'sent' | 'not_sent' | 'skipped';

export class PromotionFlowRunner<TChannel extends PromotionChannelSnapshot> {
  private readonly messageQueue: PromotionMessageQueue;
  private readonly followUpTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly bandit: DiscountedThompsonSampling;
  private readonly adapter: PromotionFlowAdapter<TChannel>;
  private readonly options: PromotionFlowRunnerOptions;
  private queueCheckInterval: ReturnType<typeof setInterval> | null = null;
  private queueCheckPromise: Promise<void> | null = null;
  private running = false;
  private startedByStart = false;
  private status: PromotionRunnerStatus = 'idle';
  private readonly health: Omit<PromotionRunnerHealthSnapshot, 'status' | 'running' | 'startedByStart' | 'queueSize'> = {
    createdAt: Date.now(),
    startedAt: null,
    stoppedAt: null,
    lastCycleStartedAt: null,
    lastCycleFinishedAt: null,
    lastQueueCheckStartedAt: null,
    lastQueueCheckFinishedAt: null,
    lastSuccessfulSendAt: null,
    lastSendFailureAt: null,
    lastDeletionAt: null,
    lastFollowUpScheduledAt: null,
    lastFollowUpStartedAt: null,
    lastFollowUpFinishedAt: null,
    lastErrorAt: null,
    lastError: null,
    totalCycles: 0,
    totalCycleFailures: 0,
    totalQueueChecks: 0,
    totalSuccessfulSends: 0,
    totalSendFailures: 0,
    totalDeletions: 0,
    totalFollowUpsScheduled: 0,
    consecutiveCycleFailures: 0,
  };

  constructor(
    adapter: PromotionFlowAdapter<TChannel>,
    options: PromotionFlowRunnerOptions,
  ) {
    if (!isAdapterLike(adapter)) {
      throw new Error('PromotionFlowRunner adapter is required');
    }
    const safeOptions = asRunnerOptions(options);
    if (!isAccountLike(safeOptions.account)) {
      throw new Error('PromotionFlowRunner account context is required');
    }
    this.adapter = adapter;
    this.options = safeOptions as PromotionFlowRunnerOptions;
    this.bandit = isBanditLike(safeOptions.bandit)
      ? safeOptions.bandit
      : new DiscountedThompsonSampling(PROMOTION_MESSAGE_STRATEGIES);
    this.messageQueue = isMessageQueueLike(safeOptions.messageQueue)
      ? safeOptions.messageQueue
      : new PromotionMessageQueue(safeOptions.maxQueueSize ?? 500);
  }

  getQueueSize(): number {
    return this.messageQueue.size;
  }

  getHealth(): PromotionRunnerHealthSnapshot {
    return {
      status: this.status,
      running: this.running,
      startedByStart: this.startedByStart,
      queueSize: this.messageQueue.size,
      ...this.health,
    };
  }

  stop(): void {
    this.status = this.running ? 'stopping' : 'stopped';
    this.running = false;
    this.stopQueueChecker();
    for (const timeout of this.followUpTimers.values()) {
      clearTimeout(timeout);
    }
    this.followUpTimers.clear();
    this.health.stoppedAt = Date.now();
    this.status = 'stopped';
    this.log('info', 'Promotion runner stopped; cleared queued follow-up timers');
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedByStart = true;
    this.status = 'running';
    this.health.startedAt = Date.now();
    this.health.stoppedAt = null;
    this.startQueueChecker();
    this.log('info', `Promotion runner started; batchTarget=${safeBatchTarget(this.options.batchTarget, Number.MAX_SAFE_INTEGER)} queueSize=${this.messageQueue.size}`);
    try {
      while (this.running) {
        let active = false;
        try {
          active = isExactTrue(await this.adapter.isActive());
        } catch (error) {
          const normalizedError = this.normalizeError(error);
          this.recordCycleFailure(normalizedError);
          this.log('error', `Promotion active-state check failed; keeping runner alive error=${normalizedError}`);
          if (this.running) await this.sleep(safeDelayMs(this.options.channelLoopDelayMs, 5000));
          continue;
        }
        if (!active) break;

        try {
          const cycleFailuresBefore = this.health.totalCycleFailures;
          await this.runOnce();
          if (this.health.totalCycleFailures === cycleFailuresBefore) {
            this.health.consecutiveCycleFailures = 0;
          }
        } catch (error) {
          const normalizedError = this.normalizeError(error);
          this.recordCycleFailure(normalizedError);
          this.log('error', `Promotion cycle failed: ${normalizedError}`);
        }
        if (this.running) await this.sleep(safeDelayMs(this.options.channelLoopDelayMs, 5000));
      }
    } finally {
      this.startedByStart = false;
      this.stop();
    }
  }

  async runOnce(): Promise<void> {
    this.health.lastCycleStartedAt = Date.now();
    this.log('debug', `Promotion cycle start; queueSize=${this.messageQueue.size}`);
    try {
      await this.checkQueuedMessages();

      let channels: TChannel[] = [];
      try {
        channels = normalizeChannels<TChannel>(await this.adapter.loadChannels());
      } catch (error) {
        const normalizedError = this.normalizeError(error);
        this.recordCycleFailure(`channel load failed: ${normalizedError}`);
        this.log('warn', `Promotion channel load failed; skipping cycle error=${normalizedError}`);
        return;
      }
      if (channels.length === 0) {
        this.log('warn', 'No channels available for promotion');
        return;
      }

      const stats = await this.getStatsOrDefault('planning');
      const batchPolicy = calculatePromotionBatchLimit({
        scoringEnabled: this.options.scoringEnabled,
        daysLeft: stats.daysLeft,
        successCount: stats.successCount,
        failedCount: stats.failedCount,
        failStreak: stats.failStreak,
        includeJitter: true,
      });
      const batchTarget = safeBatchTarget(this.options.batchTarget, batchPolicy.limit);
      let intelligenceDocs: ChannelIntelligenceDocument[] = [];
      try {
        const loadedDocs = await this.adapter.getIntelligenceDocs(channels.map((channel) => channel.channelId));
        intelligenceDocs = Array.isArray(loadedDocs) ? loadedDocs : [];
      } catch (error) {
        this.log('warn', `Promotion intelligence docs batch load failed; selecting with cold-start docs error=${this.normalizeError(error)}`);
      }
      const selection = selectPromotionChannels({
        channels,
        intelligenceDocs,
        batchTarget,
      });
      const selectionDiagnostics = this.describeSelection(selection, intelligenceDocs);
      this.log('info', [
        'Promotion selection ready',
        `loaded=${channels.length}`,
        `intelDocs=${intelligenceDocs.length}`,
        `batchTarget=${batchTarget}`,
        `policyLimit=${batchPolicy.limit}`,
        `selected=${selection.selected.length}`,
        `proven=${selection.proven.length}`,
        `untested=${selection.untested.length}`,
        `stale=${selection.stale.length}`,
        `skipped=${selection.skipped.length}`,
        `skipBreakdown=${selectionDiagnostics.skipBreakdown}`,
        `explorePct=${selection.explorePercent.toFixed(2)}`,
        `reEvalPct=${selection.reEvalPercent.toFixed(2)}`,
        `stats=${this.formatStats(stats)}`,
      ].join('; '));
      if (selectionDiagnostics.selectedSample !== 'none') {
        this.log('debug', `Promotion selected channel sample; ${selectionDiagnostics.selectedSample}`);
      }
      if (selectionDiagnostics.skippedSample !== 'none') {
        this.log('debug', `Promotion skipped channel sample; ${selectionDiagnostics.skippedSample}`);
      }

      for (const channel of selection.selected) {
        if (this.startedByStart && !this.running) {
          this.log('debug', `Promotion cycle interrupted before channel; ${this.formatChannel(channel)}`);
          break;
        }
        if (!(await this.shouldProcessNextChannel(channel))) break;
        const outcome = await this.processChannel(channel, false);
        await this.sleepAfterChannel(outcome);
      }
    } finally {
      this.health.totalCycles += 1;
      this.health.lastCycleFinishedAt = Date.now();
    }
  }

  async processChannel(rawChannel: TChannel, isFollowUp: boolean): Promise<ChannelProcessOutcome> {
    const channel = normalizeChannel<TChannel>(rawChannel);
    if (!channel) {
      this.log('warn', `Promotion channel attempt skipped; malformed channel=${this.safeJson(rawChannel)}`);
      return 'skipped';
    }
    this.log('debug', `Promotion channel attempt start; ${this.formatChannel(channel)} isFollowUp=${isFollowUp}`);
    const eligible = await this.evaluateEligibility(channel);
    if (!eligible) return 'skipped';

    const stats = await this.getStatsOrDefault('message planning');
    let doc = null;
    try {
      doc = await this.adapter.getIntelligenceDoc(channel.channelId);
    } catch (error) {
      this.log('warn', `Promotion intelligence doc load failed; using cold-start strategy; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
    }
    const strategy = this.selectStrategy(doc, channel, isFollowUp);
    const availableMessageIds = normalizeAvailableMessageIds(channel.availableMsgs);
    const messagePolicyInput: MessagePolicyInput = {
      isFollowUp,
      ...(channel.wordRestriction !== undefined ? { wordRestriction: channel.wordRestriction } : {}),
      ...(channel.dMRestriction !== undefined ? { dMRestriction: channel.dMRestriction } : {}),
      deletedCount: channel.deletedCount ?? null,
      failStreak: stats.failStreak,
      banditStrategy: strategy,
      ...(availableMessageIds !== undefined ? { availableMessageIds } : {}),
    };
    const candidates = selectPromotionMessageCandidates(messagePolicyInput);
    this.log('debug', [
      'Promotion candidate plan',
      this.formatChannel(channel),
      `isFollowUp=${isFollowUp}`,
      `strategy=${strategy ?? 'none'}`,
      `failStreak=${stats.failStreak}`,
      `deletedCount=${messagePolicyInput.deletedCount ?? 'null'}`,
      `wordRestriction=${messagePolicyInput.wordRestriction ?? 'null'}`,
      `dmRestriction=${messagePolicyInput.dMRestriction ?? 'null'}`,
      `availableMsgs=${availableMessageIds?.length ?? 'unknown'}`,
      `candidates=${candidates.map((candidate) => this.formatCandidate(candidate)).join('|')}`,
    ].join('; '));

    for (const candidate of candidates) {
      if (this.shouldAbortStartedRunnerWork()) {
        this.log('debug', `Promotion candidate loop interrupted because runner stopped; ${this.formatChannel(channel)}`);
        return 'skipped';
      }
      const result = await this.trySendPromotion(channel, candidate, isFollowUp);
      if (this.shouldAbortStartedRunnerWork()) {
        this.log('debug', `Promotion send result ignored because runner stopped; ${this.formatChannel(channel)} candidate=${this.formatCandidate(candidate)}`);
        return 'skipped';
      }
      if (result.sent) {
        await this.recordSuccess(channel, candidate, result, isFollowUp);
        return 'sent';
      }
      if (result.errorMessage) {
        await this.recordFailure(channel, candidate, result.errorMessage, isFollowUp);
      }
      if (result.terminal) {
        this.log('debug', `Promotion candidate loop stopped after terminal failure; ${this.formatChannel(channel)} candidate=${this.formatCandidate(candidate)}`);
        return 'not_sent';
      }
    }
    this.log('warn', `Promotion exhausted candidates without send; ${this.formatChannel(channel)} isFollowUp=${isFollowUp} attempts=${candidates.length}`);
    return 'not_sent';
  }

  async checkQueuedMessages(): Promise<void> {
    if (this.messageQueue.size === 0) return;
    if (this.queueCheckPromise) {
      await this.queueCheckPromise;
      return;
    }
    this.queueCheckPromise = this.checkQueuedMessagesOnce();
    try {
      await this.queueCheckPromise;
    } finally {
      this.queueCheckPromise = null;
    }
  }

  private async checkQueuedMessagesOnce(): Promise<void> {
    this.health.lastQueueCheckStartedAt = Date.now();
    try {
      const now = Date.now();
      const checkDelay = safeDelayMs(this.options.messageCheckDelayMs, 15_000);
      let ready: ReadyMessage[] = [];
      try {
        ready = normalizeReadyMessages(this.messageQueue.readyForCheck(now, checkDelay));
      } catch (error) {
        this.log('warn', `Promotion queue ready check failed; skipping queue pass error=${this.normalizeError(error)}`);
        return;
      }
      this.log('debug', `Promotion queue check; queueSize=${this.messageQueue.size} ready=${ready.length} checkDelayMs=${checkDelay}`);

      const completed = new Set<ReadyMessage>();
      for (const entry of ready) {
        if (this.shouldAbortStartedRunnerWork()) {
          this.log('debug', 'Promotion queue check interrupted because runner stopped');
          break;
        }
        const { message } = entry;
        let result: PromotionMessageCheckResult;
        try {
          result = normalizeMessageCheckResult(await this.adapter.checkMessage(message));
        } catch (error) {
          this.log('warn', [
            'Promotion message check failed; retaining for retry',
            `channelId=${message.channelId}`,
            `messageId=${message.messageId}`,
            `isFollowUp=${message.isFollowUp}`,
            `error=${this.normalizeError(error)}`,
          ].join('; '));
          continue;
        }
        if (this.shouldAbortStartedRunnerWork()) {
          this.log('debug', `Promotion queue check result ignored because runner stopped; channelId=${message.channelId} messageId=${message.messageId}`);
          break;
        }
        if (result.status === 'exists') {
          this.log('debug', `Promotion message exists; channelId=${message.channelId} messageId=${message.messageId} isFollowUp=${message.isFollowUp}`);
          await this.callHook('onMessageExisting', () => this.adapter.onMessageExisting?.(message));
          await this.scheduleFollowUp(message);
          completed.add(entry);
        } else if (result.status === 'deleted') {
          const deletionPolicy = evaluateDeletionPolicy(message.messageIndex, message.availableMessageCount);
          await this.recordDeletion(message, deletionPolicy);
          completed.add(entry);
        } else {
          this.log('debug', `Message check unknown for ${message.channelId}/${message.messageId}; retaining for retry`);
        }
      }

      for (const entry of completed) {
        try {
          this.messageQueue.remove(entry.original);
        } catch (error) {
          const { message } = entry;
          this.log('warn', `Promotion queue remove failed; channelId=${message.channelId} messageId=${message.messageId} error=${this.normalizeError(error)}`);
        }
      }
      if (completed.size > 0) {
        this.log('debug', `Promotion queue check completed; removed=${completed.size} remaining=${this.messageQueue.size}`);
      }
    } finally {
      this.health.totalQueueChecks += 1;
      this.health.lastQueueCheckFinishedAt = Date.now();
    }
  }

  private startQueueChecker(): void {
    this.stopQueueChecker();
    const intervalMs = safeIntervalMs(this.options.messageCheckIntervalMs ?? this.options.messageCheckDelayMs, 15_000);
    this.queueCheckInterval = setInterval(() => {
      if (!this.running) return;
      void this.checkQueuedMessages().catch((error) => {
        this.log('error', `Promotion queue check failed: ${this.normalizeError(error)}`);
      });
    }, intervalMs);
  }

  private stopQueueChecker(): void {
    if (this.queueCheckInterval) {
      clearInterval(this.queueCheckInterval);
      this.queueCheckInterval = null;
    }
  }

  private shouldAbortStartedRunnerWork(): boolean {
    return this.startedByStart && !this.running;
  }

  private async evaluateEligibility(channel: TChannel): Promise<boolean> {
    let percentiles = null;
    if (this.options.scoringEnabled && this.adapter.getPercentiles) {
      try {
        percentiles = await this.adapter.getPercentiles();
      } catch (error) {
        this.log('warn', `Promotion percentile load failed; using legacy eligibility; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
      }
    }
    let recentlyPromotedByOtherAccount = false;
    if (this.options.redisLockEnabled) {
      try {
        recentlyPromotedByOtherAccount = await this.options.account.isRecentlyPromoted(channel.channelId);
      } catch (error) {
        this.log('warn', `Promotion Redis lock check failed; continuing without cross-account lock signal; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
      }
    }
    let recentlyQueuedByAdapter = false;
    try {
      recentlyQueuedByAdapter = this.adapter.isRecentlyQueued?.(channel.channelId) || false;
    } catch (error) {
      this.log('warn', `Promotion adapter recent-queue check failed; continuing without adapter queue signal; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
    }
    const result = evaluatePromotionChannelEligibility({
      channel,
      scoringEnabled: this.options.scoringEnabled && !!percentiles,
      percentiles,
      recentlyQueued: this.messageQueue.isQueued(channel.channelId)
        || this.followUpTimers.has(channel.channelId)
        || recentlyQueuedByAdapter,
      recentlyPromotedByOtherAccount,
    });
    if (!result.eligible) this.log('debug', `Skipping ${channel.channelId}: ${result.reason}`);
    return result.eligible;
  }

  private async trySendPromotion(
    channel: TChannel,
    candidate: PromotionMessageCandidate,
    isFollowUp: boolean,
  ): Promise<PromotionSendResult> {
    try {
      return normalizeSendResult(await this.adapter.sendPromotion({ channel, candidate, isFollowUp }), candidate);
    } catch (error) {
      const errorMessage = this.normalizeError(error);
      this.log('error', [
        'Promotion adapter send threw',
        this.formatChannel(channel),
        `candidate=${this.formatCandidate(candidate)}`,
        `isFollowUp=${isFollowUp}`,
        `reason=${this.compact(errorMessage)}`,
      ].join('; '));
      return {
        sent: false,
        messageIndex: candidate.randomIndex,
        errorMessage,
        terminal: true,
      };
    }
  }

  private async recordSuccess(
    channel: TChannel,
    candidate: PromotionMessageCandidate,
    result: PromotionSendResult,
    isFollowUp: boolean,
  ): Promise<void> {
    const strategy = this.resolveCandidateStrategy(candidate);
    const availableMessageIds = normalizeAvailableMessageIds(channel.availableMsgs);
    if (isValidMessageId(result.messageId)) {
      const queuedMessage: PromotionQueuedMessage = {
        channelId: channel.channelId,
        messageId: result.messageId,
        timestamp: Date.now(),
        messageIndex: result.messageIndex,
        strategy,
        isFollowUp,
        ...(availableMessageIds !== undefined ? { availableMessageCount: availableMessageIds.length } : {}),
      };
      this.messageQueue.enqueue(queuedMessage);
    } else {
      this.log('warn', `Promotion send returned without messageId; not queueing deletion/follow-up check; ${this.formatChannel(channel)} messageIndex=${result.messageIndex} isFollowUp=${isFollowUp}`);
    }
    this.log('info', [
      'Promotion send recorded',
      this.formatChannel(channel),
      `messageId=${result.messageId ?? 'unknown'}`,
      `messageIndex=${result.messageIndex}`,
      `strategy=${strategy}`,
      `isFollowUp=${isFollowUp}`,
      `queueSize=${this.messageQueue.size}`,
      `attribution=${this.options.attributionEnabled}`,
      `redisLock=${this.options.redisLockEnabled}`,
      `bandit=${this.options.messageBanditEnabled}`,
    ].join('; '));
    this.health.totalSuccessfulSends += 1;
    this.health.lastSuccessfulSendAt = Date.now();
    await this.callHook('onSendSuccess', () => this.adapter.onSendSuccess?.(channel, result, isFollowUp));
    let intelligenceStatus: PromotionHookStatus = 'ok';
    let attributionStatus: PromotionHookStatus = this.options.attributionEnabled ? 'ok' : 'off';
    let redisLockStatus: PromotionHookStatus = this.options.redisLockEnabled ? 'ok' : 'off';
    try {
      await this.options.account.recordSuccess(channel.channelId, strategy, isFollowUp);
      await this.options.account.intelligence.refreshChannelMeta(
        channel.channelId,
        channel.title || '',
        channel.username || null,
        channel.participantsCount || 0,
      );
    } catch (error) {
      intelligenceStatus = 'fail';
      this.log('warn', `Promotion intelligence success record failed after local success accounting; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
    }
    const banditStatus = this.updateBandit(strategy, 1, channel);
    if (this.options.attributionEnabled) {
      try {
        await this.options.account.recordSend(channel.channelId);
      } catch (error) {
        attributionStatus = 'fail';
        this.log('warn', `Promotion attribution record failed after local success accounting; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
      }
    }
    if (this.options.redisLockEnabled) {
      try {
        await this.options.account.markPromoted(channel.channelId);
      } catch (error) {
        redisLockStatus = 'fail';
        this.log('warn', `Promotion Redis lock record failed after local success accounting; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
      }
    }
    this.logHookSummary('success', channel.channelId, strategy, isFollowUp, {
      intelligence: intelligenceStatus,
      attribution: attributionStatus,
      redisLock: redisLockStatus,
      bandit: banditStatus,
    });
  }

  private async recordFailure(
    channel: TChannel,
    candidate: PromotionMessageCandidate,
    errorMessage: string,
    isFollowUp: boolean,
  ): Promise<void> {
    const strategy = this.resolveCandidateStrategy(candidate);
    this.log('warn', [
      'Promotion send failed',
      this.formatChannel(channel),
      `candidate=${this.formatCandidate(candidate)}`,
      `strategy=${strategy}`,
      `isFollowUp=${isFollowUp}`,
      `reason=${this.compact(errorMessage)}`,
    ].join('; '));
    this.health.totalSendFailures += 1;
    this.health.lastSendFailureAt = Date.now();
    await this.callHook('onSendFailure', () => this.adapter.onSendFailure?.(channel, errorMessage, isFollowUp));
    let intelligenceStatus: PromotionHookStatus = 'ok';
    try {
      await this.options.account.recordFailure(channel.channelId, strategy, errorMessage);
    } catch (error) {
      intelligenceStatus = 'fail';
      this.log('warn', `Promotion intelligence failure record failed after local failure accounting; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
    }
    const banditStatus = this.updateBandit(strategy, 0, channel);
    this.logHookSummary('failure', channel.channelId, strategy, isFollowUp, {
      intelligence: intelligenceStatus,
      attribution: 'skipped',
      redisLock: 'skipped',
      bandit: banditStatus,
    });
  }

  private resolveCandidateStrategy(candidate: PromotionMessageCandidate): MessageStrategy {
    return candidate.strategy || messageIndexToStrategy(candidate.randomIndex) || 'legacy';
  }

  private async recordDeletion(
    message: PromotionQueuedMessage,
    deletionPolicy: DeletionPolicyResult,
  ): Promise<void> {
    const strategy = message.strategy || deletionPolicy.strategy || 'legacy';
    this.log('warn', [
      'Promotion deletion recorded',
      `channelId=${message.channelId}`,
      `messageId=${message.messageId}`,
      `messageIndex=${message.messageIndex}`,
      `strategy=${strategy}`,
      `isFollowUp=${message.isFollowUp}`,
      `survivalMs=${safeElapsedMs(message.timestamp)}`,
      `actions=${deletionPolicy.actions.join('|') || 'none'}`,
    ].join('; '));
    this.health.totalDeletions += 1;
    this.health.lastDeletionAt = Date.now();
    await this.callHook('onMessageDeleted', () => this.adapter.onMessageDeleted?.(message, deletionPolicy));
    let intelligenceStatus: PromotionHookStatus = 'ok';
    try {
      await this.options.account.recordDeletion(
        message.channelId,
        strategy,
        safeElapsedMs(message.timestamp),
        message.isFollowUp,
      );
    } catch (error) {
      intelligenceStatus = 'fail';
      this.log('warn', `Promotion intelligence deletion record failed after local deletion accounting; channelId=${message.channelId} error=${this.normalizeError(error)}`);
    }
    const banditStatus = this.updateBandit(strategy, 0, message);
    this.logHookSummary('deletion', message.channelId, strategy, message.isFollowUp, {
      intelligence: intelligenceStatus,
      attribution: 'skipped',
      redisLock: 'skipped',
      bandit: banditStatus,
    });
  }

  private selectStrategy(
    doc: ChannelIntelligenceDocument | null,
    channel: TChannel,
    isFollowUp: boolean,
  ): MessageStrategy | null {
    if (!this.options.messageBanditEnabled || isFollowUp) return null;
    try {
      return selectChannelStrategy(doc, this.bandit);
    } catch (error) {
      this.log('warn', `Promotion bandit strategy selection failed; using default message candidates; ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
      return null;
    }
  }

  private updateBandit(
    strategy: MessageStrategy,
    reward: 0 | 1,
    source: PromotionChannelSnapshot | PromotionQueuedMessage,
  ): PromotionHookStatus {
    if (!this.options.messageBanditEnabled) return 'off';
    try {
      this.bandit.update(strategy, reward);
      return 'ok';
    } catch (error) {
      const channelId = 'channelId' in source ? source.channelId : 'unknown';
      this.log('warn', `Promotion bandit update failed; channelId=${channelId} strategy=${strategy} reward=${reward} error=${this.normalizeError(error)}`);
      return 'fail';
    }
  }

  private logHookSummary(
    event: 'success' | 'failure' | 'deletion',
    channelId: string,
    strategy: MessageStrategy,
    isFollowUp: boolean,
    statuses: {
      intelligence: PromotionHookStatus;
      attribution: PromotionHookStatus;
      redisLock: PromotionHookStatus;
      bandit: PromotionHookStatus;
    },
  ): void {
    this.log('debug', [
      'Promotion hook summary',
      `event=${event}`,
      `channelId=${channelId}`,
      `strategy=${strategy}`,
      `isFollowUp=${isFollowUp}`,
      `intelligence=${statuses.intelligence}`,
      `attribution=${statuses.attribution}`,
      `redisLock=${statuses.redisLock}`,
      `bandit=${statuses.bandit}`,
    ].join('; '));
  }

  private async scheduleFollowUp(message: PromotionQueuedMessage): Promise<void> {
    let stats;
    try {
      stats = normalizeStats(await this.adapter.getStats());
    } catch (error) {
      this.log('warn', `Follow-up stats load failed; not scheduling follow-up; channelId=${message.channelId} messageId=${message.messageId} error=${this.normalizeError(error)}`);
      return;
    }
    const existing = this.followUpTimers.get(message.channelId);
    const activeFollowUpCount = existing ? Math.max(0, this.followUpTimers.size - 1) : this.followUpTimers.size;
    const followUpPolicy = evaluateFollowUpScheduling({
      isFollowUp: message.isFollowUp,
      daysLeft: stats.daysLeft,
      channelAvailable: true,
      activeFollowUpCount,
      ...(this.options.maxFollowUpCount !== undefined ? { maxFollowUpCount: safeNonNegativeInt(this.options.maxFollowUpCount) } : {}),
    });
    if (!followUpPolicy.shouldSchedule) {
      this.log('debug', `Follow-up not scheduled; channelId=${message.channelId} messageId=${message.messageId} reason=${followUpPolicy.reason ?? 'policy'}`);
      return;
    }

    const delayMs = calculateFollowUpDelay(
      safeDelayMs(this.options.followUpDelayMs, 15 * 60_000),
      safeDelayMs(this.options.followUpJitterMs, 30_000),
    );
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      this.followUpTimers.delete(message.channelId);
      if (this.shouldAbortStartedRunnerWork()) {
        this.log('debug', `Follow-up timer skipped because runner stopped; channelId=${message.channelId} messageId=${message.messageId}`);
        return;
      }
      void this.runFollowUp(message);
    }, delayMs);
    this.followUpTimers.set(message.channelId, timeout);
    this.log('info', `Follow-up scheduled; channelId=${message.channelId} messageId=${message.messageId} delayMs=${delayMs} activeFollowUps=${this.followUpTimers.size} replacedExisting=${!!existing}`);
    this.health.totalFollowUpsScheduled += 1;
    this.health.lastFollowUpScheduledAt = Date.now();
    void this.callHook('onFollowUpScheduled', () => this.adapter.onFollowUpScheduled?.(message, delayMs));
  }

  private async runFollowUp(message: PromotionQueuedMessage): Promise<void> {
    this.health.lastFollowUpStartedAt = Date.now();
    try {
      this.log('debug', `Follow-up execution start; channelId=${message.channelId} messageId=${message.messageId}`);
      if (this.shouldAbortStartedRunnerWork()) {
        this.log('debug', `Skipping follow-up for ${message.channelId}: runner stopped`);
        return;
      }
      if (!isExactTrue(await this.adapter.isActive())) {
        this.log('debug', `Skipping follow-up for ${message.channelId}: adapter inactive`);
        return;
      }
      if (this.adapter.shouldContinue && !isExactTrue(await this.adapter.shouldContinue())) {
        this.log('debug', `Skipping follow-up for ${message.channelId}: shouldContinue returned false`);
        return;
      }
      let stats;
      try {
        stats = normalizeStats(await this.adapter.getStats());
      } catch (error) {
        this.log('warn', `Follow-up execution stats load failed; skipping follow-up; channelId=${message.channelId} messageId=${message.messageId} error=${this.normalizeError(error)}`);
        return;
      }
      const followUpPolicy = evaluateFollowUpScheduling({
        isFollowUp: message.isFollowUp,
        daysLeft: stats.daysLeft,
        channelAvailable: true,
      });
      if (!followUpPolicy.shouldSchedule) {
        this.log('debug', `Skipping follow-up for ${message.channelId}: ${followUpPolicy.reason ?? 'policy'}`);
        return;
      }
      const channel = await this.adapter.getChannel(message.channelId);
      if (!channel) {
        this.log('debug', `Skipping follow-up for ${message.channelId}: channel unavailable`);
        return;
      }
      await this.processChannel(channel, true);
    } catch (error) {
      this.log('error', `Follow-up failed for ${message.channelId}: ${this.normalizeError(error)}`);
    } finally {
      this.health.lastFollowUpFinishedAt = Date.now();
    }
  }

  private async sleep(ms: number): Promise<void> {
    const delayMs = safeDelayMs(ms, 0);
    try {
      await (this.adapter.sleep || defaultSleep)(delayMs);
    } catch (error) {
      this.log('warn', `Promotion sleep failed; using default timer fallback delayMs=${delayMs} error=${this.normalizeError(error)}`);
      await defaultSleep(delayMs);
    }
  }

  private async sleepAfterChannel(outcome: ChannelProcessOutcome): Promise<void> {
    if (outcome !== 'sent') {
      const delayMs = randomIntInclusive(FAILED_CHANNEL_RETRY_MIN_MS, FAILED_CHANNEL_RETRY_MAX_MS);
      this.log('debug', `Promotion retry delay ${delayMs}ms (${outcome})`);
      await this.sleep(delayMs);
      return;
    }
    if (!this.options.scoringEnabled) {
      await this.sleep(safeDelayMs(this.options.channelLoopDelayMs, 5000));
      return;
    }
    let stats;
    try {
      stats = normalizeStats(await this.adapter.getStats());
    } catch (error) {
      this.log('warn', `Promotion delay stats load failed; using configured channel loop delay error=${this.normalizeError(error)}`);
      await this.sleep(safeDelayMs(this.options.channelLoopDelayMs, 5000));
      return;
    }
    const delay = calculateHealthBasedPromotionDelay({
      successCount: stats.successCount,
      failedCount: stats.failedCount,
      failStreak: stats.failStreak,
    });
    this.log('debug', `Promotion delay ${delay.delayMs}ms (${delay.mode})`);
    await this.sleep(delay.delayMs);
  }

  private async getStatsOrDefault(context: string): Promise<PromotionFlowStats> {
    try {
      return normalizeStats(await this.adapter.getStats());
    } catch (error) {
      this.log('warn', `Promotion stats load failed during ${context}; using safe zero counters error=${this.normalizeError(error)}`);
      return normalizeStats(null);
    }
  }

  private async shouldProcessNextChannel(channel: TChannel): Promise<boolean> {
    try {
      if (!isExactTrue(await this.adapter.isActive())) {
        this.log('debug', `Promotion cycle stopped before channel; adapter inactive ${this.formatChannel(channel)}`);
        return false;
      }
    } catch (error) {
      this.log('warn', `Promotion cycle stopped before channel; active check failed ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
      return false;
    }

    if (!this.adapter.shouldContinue) return true;
    try {
      if (!isExactTrue(await this.adapter.shouldContinue())) {
        this.log('debug', `Promotion cycle stopped before channel; shouldContinue=false ${this.formatChannel(channel)}`);
        return false;
      }
    } catch (error) {
      this.log('warn', `Promotion cycle stopped before channel; shouldContinue check failed ${this.formatChannel(channel)} error=${this.normalizeError(error)}`);
      return false;
    }

    return true;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    try {
      this.adapter.log?.(level, message);
    } catch {
      // Logging must never change promotion control flow.
    }
  }

  private async callHook(name: string, hook: () => Promise<void> | void | undefined): Promise<void> {
    try {
      await hook();
    } catch (error) {
      this.log('warn', `Promotion adapter hook failed; hook=${name} error=${this.normalizeError(error)}`);
    }
  }

  private formatStats(stats: { successCount: number; failedCount: number; failStreak: number; daysLeft: number }): string {
    return `success=${stats.successCount},failed=${stats.failedCount},failStreak=${stats.failStreak},daysLeft=${stats.daysLeft}`;
  }

  private describeSelection(
    selection: ChannelSelectionResult<TChannel>,
    intelligenceDocs: ChannelIntelligenceDocument[],
  ): { skipBreakdown: string; selectedSample: string; skippedSample: string } {
    const intelligenceByChannel = new Map<string, ChannelIntelligenceDocument>();
    for (const doc of intelligenceDocs) {
      const channelId = normalizeChannelId(doc.channelId);
      if (channelId) intelligenceByChannel.set(channelId, doc);
    }

    const proven = this.toChannelIdSet(selection.proven);
    const untested = this.toChannelIdSet(selection.untested);
    const stale = this.toChannelIdSet(selection.stale);
    const skipCounts = new Map<string, number>();
    for (const channel of selection.skipped) {
      const reason = this.getSkippedSelectionReason(channel, intelligenceByChannel).bucket;
      skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
    }

    return {
      skipBreakdown: this.formatCounts(skipCounts),
      selectedSample: this.summarizeSelectionChannels(selection.selected, (channel) => {
        const channelId = normalizeChannelId(channel.channelId);
        if (channelId && proven.has(channelId)) return 'proven';
        if (channelId && untested.has(channelId)) return 'untested';
        if (channelId && stale.has(channelId)) return 'stale';
        return 'backfill';
      }),
      skippedSample: this.summarizeSelectionChannels(selection.skipped, (channel) => {
        return this.getSkippedSelectionReason(channel, intelligenceByChannel).sample;
      }),
    };
  }

  private toChannelIdSet(channels: PromotionChannelSnapshot[]): Set<string> {
    const ids = new Set<string>();
    for (const channel of channels) {
      const channelId = normalizeChannelId(channel.channelId);
      if (channelId) ids.add(channelId);
    }
    return ids;
  }

  private getSkippedSelectionReason(
    channel: PromotionChannelSnapshot,
    intelligenceByChannel: Map<string, ChannelIntelligenceDocument>,
  ): { bucket: string; sample: string } {
    const channelId = normalizeChannelId(channel.channelId);
    if (!channelId) return { bucket: 'invalid-channel-id', sample: 'invalid-channel-id' };
    const doc = intelligenceByChannel.get(channelId);
    if (!doc) return { bucket: 'duplicate-or-invalid', sample: 'duplicate-or-invalid' };
    if (doc.stage === 'hostile') return { bucket: 'hostile', sample: 'hostile' };
    const cooldownUntil = typeof doc.cooldownUntil === 'number' ? doc.cooldownUntil : 0;
    if (cooldownUntil > Date.now()) {
      const cooldownMinutes = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 60_000));
      return { bucket: 'cooldown', sample: `cooldown:${cooldownMinutes}m` };
    }
    return { bucket: 'selection-filter', sample: `selection-filter:${doc.stage}` };
  }

  private summarizeSelectionChannels(
    channels: PromotionChannelSnapshot[],
    label: (channel: PromotionChannelSnapshot) => string,
  ): string {
    if (channels.length === 0) return 'none';
    return channels
      .slice(0, 8)
      .map((channel) => `${this.formatCompactChannel(channel)}:${label(channel)}`)
      .join('|');
  }

  private formatCounts(counts: Map<string, number>): string {
    if (counts.size === 0) return 'none';
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `${reason}:${count}`)
      .join('|');
  }

  private formatChannel(channel: PromotionChannelSnapshot): string {
    return [
      `channelId=${channel.channelId}`,
      `username=${channel.username ?? 'unknown'}`,
      `participants=${channel.participantsCount ?? 'unknown'}`,
      `deleted=${channel.deletedCount ?? 0}`,
      `success=${channel.successMsgCount ?? 0}`,
      `failures=${channel.failureMsgCount ?? 0}`,
    ].join(' ');
  }

  private formatCompactChannel(channel: PromotionChannelSnapshot): string {
    return [
      `channelId=${channel.channelId}`,
      `username=${channel.username ?? 'unknown'}`,
      `participants=${channel.participantsCount ?? 'unknown'}`,
    ].join(',');
  }

  private formatCandidate(candidate: PromotionMessageCandidate): string {
    return `${candidate.kind}:${candidate.randomIndex}:${candidate.strategy ?? 'none'}`;
  }

  private compact(value: string): string {
    return value.replace(/\s+/g, ' ').slice(0, 240);
  }

  private safeJson(value: unknown): string {
    try {
      const serialized = JSON.stringify(value);
      return typeof serialized === 'string' ? this.compact(serialized) : String(value);
    } catch {
      return String(value);
    }
  }

  private normalizeError(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private recordCycleFailure(error: string): void {
    this.health.totalCycleFailures += 1;
    this.health.consecutiveCycleFailures += 1;
    this.health.lastErrorAt = Date.now();
    this.health.lastError = this.compact(error);
  }
}

function safeBatchTarget(value: number | undefined, policyLimit: number): number {
  const safeLimit = safeNonNegativeInt(policyLimit);
  if (value === undefined) return safeLimit;
  const safeValue = safeNonNegativeInt(value);
  return Math.min(safeValue, safeLimit);
}

function safeDelayMs(value: number | undefined, fallback: number): number {
  if (value !== undefined && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return safeNonNegativeInt(fallback);
}

function randomIntInclusive(min: number, max: number): number {
  const safeMin = safeNonNegativeInt(min);
  const safeMax = Math.max(safeMin, safeNonNegativeInt(max));
  return safeMin + Math.floor(Math.random() * (safeMax - safeMin + 1));
}

function safeIntervalMs(value: number | undefined, fallback: number): number {
  const delayMs = safeDelayMs(value, fallback);
  return Math.max(1000, delayMs);
}

function normalizeStats(value: unknown): PromotionFlowStats {
  const stats = isRecord(value) ? value : {};
  return {
    successCount: safeNonNegativeInt(asNumber(stats['successCount'])),
    failedCount: safeNonNegativeInt(asNumber(stats['failedCount'])),
    failStreak: safeNonNegativeInt(asNumber(stats['failStreak'])),
    daysLeft: safeNonNegativeInt(asNumber(stats['daysLeft'])),
  };
}

function normalizeMessageCheckResult(value: unknown): { status: 'exists' | 'deleted' | 'unknown' } {
  return isRecord(value) && (
    value['status'] === 'exists'
    || value['status'] === 'deleted'
    || value['status'] === 'unknown'
  )
    ? { status: value['status'] }
    : { status: 'unknown' };
}

function normalizeSendResult(value: unknown, candidate: PromotionMessageCandidate): PromotionSendResult {
  if (!isRecord(value)) {
    return {
      sent: false,
      messageIndex: candidate.randomIndex,
      errorMessage: 'Malformed promotion send result',
      terminal: true,
    };
  }

  const messageIndex = typeof value['messageIndex'] === 'string' && value['messageIndex'].trim().length > 0
    ? value['messageIndex'].trim()
    : candidate.randomIndex;
  const errorMessage = typeof value['errorMessage'] === 'string' && value['errorMessage'].trim().length > 0
    ? value['errorMessage'].trim()
    : undefined;
  const rawMessageId = typeof value['messageId'] === 'number' ? value['messageId'] : undefined;
  const messageId = isValidMessageId(rawMessageId) ? rawMessageId : undefined;

  return {
    sent: value['sent'] === true,
    messageIndex,
    ...(messageId !== undefined ? { messageId } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(value['terminal'] === true ? { terminal: true } : {}),
  };
}

function normalizeChannels<TChannel extends PromotionChannelSnapshot>(value: unknown): TChannel[] {
  if (!Array.isArray(value)) return [];
  const channels: TChannel[] = [];
  for (const item of value) {
    const channel = normalizeChannel<TChannel>(item);
    if (channel) channels.push(channel);
  }
  return channels;
}

function normalizeChannel<TChannel extends PromotionChannelSnapshot>(value: unknown): TChannel | null {
  if (!isRecord(value)) return null;
  const channelId = normalizeChannelId(value['channelId']);
  if (!channelId) return null;
  return {
    ...value,
    channelId,
  } as TChannel;
}

function normalizeAvailableMessageIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function normalizeReadyMessages(value: unknown): ReadyMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ReadyMessage[] = [];
  for (const item of value) {
    const message = normalizeReadyMessage(item);
    if (message) messages.push({ message, original: item as PromotionQueuedMessage });
  }
  return messages;
}

function normalizeReadyMessage(value: unknown): PromotionQueuedMessage | null {
  if (!isRecord(value)) return null;
  const channelId = normalizeChannelId(value['channelId']);
  const messageId = asNumber(value['messageId']);
  if (!channelId || !isValidMessageId(messageId)) return null;
  const timestamp = asNumber(value['timestamp']);
  const availableMessageCount = normalizePositiveInt(value['availableMessageCount']);
  const strategy = normalizeMessageStrategy(value['strategy']);
  return {
    channelId,
    messageId,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : 0,
    messageIndex: normalizeText(value['messageIndex']) ?? '0',
    ...(strategy ? { strategy } : {}),
    isFollowUp: value['isFollowUp'] === true,
    ...(availableMessageCount !== null ? { availableMessageCount } : {}),
  };
}

function safeNonNegativeInt(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizePositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function safeElapsedMs(startTimestamp: number): number {
  if (!Number.isFinite(startTimestamp) || startTimestamp <= 0) return 0;
  return Math.max(0, Date.now() - startTimestamp);
}

function isValidMessageId(messageId: number | undefined): messageId is number {
  return messageId !== undefined && Number.isSafeInteger(messageId) && messageId > 0;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function isExactTrue(value: unknown): boolean {
  return value === true;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeMessageStrategy(value: unknown): MessageStrategy | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (PROMOTION_MESSAGE_STRATEGIES as string[]).includes(normalized)
    ? normalized as MessageStrategy
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRunnerOptions(value: unknown): Partial<PromotionFlowRunnerOptions> {
  return isRecord(value) ? value as Partial<PromotionFlowRunnerOptions> : {};
}

function isAdapterLike(value: unknown): value is PromotionFlowAdapter<PromotionChannelSnapshot> {
  return isRecord(value)
    && typeof value['isActive'] === 'function'
    && typeof value['getStats'] === 'function'
    && typeof value['loadChannels'] === 'function'
    && typeof value['getChannel'] === 'function'
    && typeof value['getIntelligenceDocs'] === 'function'
    && typeof value['getIntelligenceDoc'] === 'function'
    && typeof value['sendPromotion'] === 'function'
    && typeof value['checkMessage'] === 'function';
}

function isAccountLike(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value['intelligence'])
    && typeof value['recordSuccess'] === 'function'
    && typeof value['recordDeletion'] === 'function'
    && typeof value['recordFailure'] === 'function'
    && typeof value['recordSend'] === 'function'
    && typeof value['markPromoted'] === 'function'
    && typeof value['isRecentlyPromoted'] === 'function'
    && typeof value['intelligence']['refreshChannelMeta'] === 'function';
}

function isBanditLike(value: unknown): value is DiscountedThompsonSampling {
  return isRecord(value)
    && typeof value['selectArm'] === 'function'
    && typeof value['update'] === 'function';
}

function isMessageQueueLike(value: unknown): value is PromotionMessageQueue {
  return isRecord(value)
    && typeof value['size'] === 'number'
    && typeof value['enqueue'] === 'function'
    && typeof value['isQueued'] === 'function'
    && typeof value['readyForCheck'] === 'function'
    && typeof value['remove'] === 'function';
}

import {
  calculateFollowUpDelay,
  calculateHealthBasedPromotionDelay,
  calculatePromotionBatchLimit,
  evaluateDeletionPolicy,
  evaluateFollowUpScheduling,
  evaluatePromotionChannelEligibility,
  messageIndexToStrategy,
  selectPromotionMessageCandidates,
} from '../src';

describe('promotion policy', () => {
  describe('evaluatePromotionChannelEligibility', () => {
    it('returns a safe negative result for malformed top-level eligibility input', () => {
      expect(evaluatePromotionChannelEligibility(null as unknown as Parameters<typeof evaluatePromotionChannelEligibility>[0]))
        .toEqual({ eligible: false, reason: 'Invalid channel' });
      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: null as unknown as Parameters<typeof evaluatePromotionChannelEligibility>[0]['channel'],
      })).toEqual({ eligible: false, reason: 'Invalid channel' });
    });

    it('requires exact boolean flags for hard-stop states from untyped callers', () => {
      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: 'true' as unknown as boolean,
        recentlyQueued: 'true' as unknown as boolean,
        recentlyPromotedByOtherAccount: 'true' as unknown as boolean,
        channel: {
          channelId: 'ch1',
          participantsCount: 1000,
          canSendMsgs: true,
          banned: 'true' as unknown as boolean,
          restricted: 'true' as unknown as boolean,
          forbidden: 'true' as unknown as boolean,
          broadcast: 'true' as unknown as boolean,
        },
      })).toEqual({ eligible: true, reason: null });
    });

    it('blocks explicit channel hard-stop states before scoring checks', () => {
      const baseChannel = { channelId: 'ch-hard', participantsCount: 1000, canSendMsgs: true };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, banned: true },
      })).toEqual({ eligible: false, reason: 'banned' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, restricted: true },
      })).toEqual({ eligible: false, reason: 'restricted' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, forbidden: true },
      })).toEqual({ eligible: false, reason: 'forbidden' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, private: true },
      })).toEqual({ eligible: false, reason: 'private' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, canSendMsgs: false },
      })).toEqual({ eligible: false, reason: 'canSendMsgs_false' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { channelId: 'missing-sendability', participantsCount: 1000 },
      })).toEqual({ eligible: false, reason: 'canSendMsgs_missing' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, broadcast: true },
      })).toEqual({ eligible: false, reason: 'broadcast' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, sendMessages: true },
      })).toEqual({ eligible: false, reason: 'sendMessages' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, sendPlain: true },
      })).toEqual({ eligible: false, reason: 'sendPlain' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { ...baseChannel, availableMsgs: [] },
      })).toEqual({ eligible: true, reason: null });
    });

    it('uses health score penalties instead of legacy participant/deletion hard skips', () => {
      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: false,
        channel: { channelId: 'ch1', participantsCount: 100, canSendMsgs: true },
      })).toEqual({ eligible: true, reason: null });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: false,
        channel: { channelId: 'ch1', participantsCount: 1000, deletedCount: 31, canSendMsgs: true },
      })).toEqual({ eligible: true, reason: null });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: false,
        channel: {
          channelId: 'ch1',
          participantsCount: 40,
          deletedCount: 4,
          failureMsgCount: 9,
          availableMsgs: [],
          wordRestriction: 8,
          canSendMsgs: true,
        },
      })).toEqual({ eligible: false, reason: 'health_score_below_threshold:0' });
    });

    it('enforces cross-account recent promotion locks even when scoring is disabled', () => {
      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: false,
        recentlyPromotedByOtherAccount: true,
        channel: { channelId: 'ch1', participantsCount: 1000, canSendMsgs: true },
      })).toEqual({ eligible: false, reason: 'Recently promoted by another account' });
    });

    it('blocks recently queued and recent local failures before positive eligibility', () => {
      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: false,
        recentlyQueued: true,
        channel: { channelId: 'ch1', participantsCount: 1000, canSendMsgs: true },
      })).toEqual({ eligible: false, reason: 'Recently promoted (in queue)' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: false,
        previousResult: {
          success: false,
          errorMessage: 'FLOOD_WAIT',
          lastCheckTimestamp: Date.now(),
        },
        channel: { channelId: 'ch1', participantsCount: 1000, canSendMsgs: true },
      })).toEqual({ eligible: false, reason: 'Recent failure (FLOOD_WAIT)' });
    });

    it('ignores malformed or future-dated previous failure timestamps', () => {
      const now = 1_000_000;
      const channel = { channelId: 'ch1', participantsCount: 1000, canSendMsgs: true };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: false,
        now,
        previousResult: {
          success: false,
          errorMessage: 'FUTURE_BAD_DATA',
          lastCheckTimestamp: now + 60_000,
        },
        channel,
      })).toEqual({ eligible: true, reason: null });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: false,
        now,
        previousResult: {
          success: false,
          errorMessage: 'NAN_BAD_DATA',
          lastCheckTimestamp: Number.NaN,
        },
        channel,
      })).toEqual({ eligible: true, reason: null });
    });

    it('uses percentile and classification policy when scoring is enabled', () => {
      const percentiles = {
        getPercentileRankSync: (_value: number, metric: string) => {
          if (metric === 'participantsCount') return 0.5;
          if (metric === 'successRate') return 0.5;
          if (metric === 'deleteRate') return 0.91;
          return 0.5;
        },
      };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: {
          channelId: 'ch1',
          participantsCount: 1000,
          deletedCount: 20,
          successMsgCount: 10,
          failureMsgCount: 10,
          canSendMsgs: true,
        },
        percentiles,
        random: () => 0.5,
      })).toEqual({ eligible: false, reason: 'Delete rate p90+' });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: { channelId: 'ch2', participantsCount: 1000, canSendMsgs: true },
        percentiles,
        classification: { category: 'off_topic', confidence: 0.8 },
        random: () => 0.9,
      })).toEqual({ eligible: false, reason: 'Off-topic (0.80 confidence)' });
    });

    it('allows healthy scoring-enabled channels even when legacy participant floor would fail', () => {
      const percentiles = {
        getPercentileRankSync: (_value: number, metric: string) => {
          if (metric === 'participantsCount') return 0.50;
          if (metric === 'successRate') return 0.50;
          if (metric === 'deleteRate') return 0.10;
          return 0.50;
        },
      };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: {
          channelId: 'small-but-normal',
          participantsCount: 250,
          successMsgCount: 4,
          failureMsgCount: 0,
          canSendMsgs: true,
        },
        percentiles,
      })).toEqual({ eligible: true, reason: null });
    });

    it('uses randomized exploration gates for high delete-rate channels', () => {
      const percentiles = {
        getPercentileRankSync: (_value: number, metric: string) => {
          if (metric === 'participantsCount') return 0.50;
          if (metric === 'successRate') return 0.50;
          if (metric === 'deleteRate') return 0.80;
          return 0.50;
        },
      };
      const channel = {
        channelId: 'risky',
        participantsCount: 1000,
        deletedCount: 8,
        successMsgCount: 10,
        failureMsgCount: 0,
        canSendMsgs: true,
      };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel,
        percentiles,
        random: () => 0.29,
      })).toEqual({ eligible: true, reason: null });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel,
        percentiles,
        random: () => 0.31,
      })).toEqual({ eligible: false, reason: 'Delete rate p75-p90' });
    });

    it('does not block account-local failure counts under scoring', () => {
      const percentiles = {
        getPercentileRankSync: (_value: number, metric: string) => {
          if (metric === 'successRate') return 0.05;
          if (metric === 'participantsCount') return 0.50;
          return 0.50;
        },
      };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: {
          channelId: 'poor-success',
          participantsCount: 1000,
          successMsgCount: 1,
          failureMsgCount: 24,
          canSendMsgs: true,
        },
        percentiles,
      })).toEqual({ eligible: true, reason: null });
    });

    it('blocks bottom-decile participant channels under scoring', () => {
      const percentiles = {
        getPercentileRankSync: (_value: number, metric: string) => {
          if (metric === 'participantsCount') return 0.05;
          return 0.50;
        },
      };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: {
          channelId: 'tiny-percentile',
          participantsCount: 50,
          successMsgCount: 0,
          failureMsgCount: 0,
          canSendMsgs: true,
        },
        percentiles,
      })).toEqual({ eligible: false, reason: 'Participants in bottom 10% (50)' });
    });

    it('normalizes malformed counters and random values before scoring gates', () => {
      const rankInputs: Array<{ value: number; metric: string }> = [];
      const percentiles = {
        getPercentileRankSync: (value: number, metric: string) => {
          rankInputs.push({ value, metric });
          return 0.50;
        },
      };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: {
          channelId: 'malformed',
          participantsCount: Number.NaN,
          deletedCount: Number.POSITIVE_INFINITY,
          successMsgCount: -3,
          failureMsgCount: Number.NaN,
          canSendMsgs: true,
        },
        percentiles,
        random: () => Number.NaN,
      })).toEqual({ eligible: true, reason: null });

      expect(rankInputs).toEqual([
        { value: 0, metric: 'participantsCount' },
      ]);
    });

    it('treats throwing or malformed percentile providers as neutral ranks', () => {
      const throwingPercentiles = {
        getPercentileRankSync: () => { throw new Error('percentile cache unavailable'); },
      };
      const malformedPercentiles = {
        getPercentileRankSync: () => Number.POSITIVE_INFINITY,
      };
      const channel = {
        channelId: 'percentile-fallback',
        participantsCount: 1000,
        deletedCount: 10,
        successMsgCount: 10,
        failureMsgCount: 0,
        canSendMsgs: true,
      };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel,
        percentiles: throwingPercentiles,
      })).toEqual({ eligible: true, reason: null });

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel,
        percentiles: malformedPercentiles,
      })).toEqual({ eligible: true, reason: null });
    });

    it('keeps exploration allowance for p90 delete-rate channels deterministic', () => {
      const percentiles = {
        getPercentileRankSync: (_value: number, metric: string) => {
          if (metric === 'participantsCount') return 0.50;
          if (metric === 'successRate') return 0.50;
          if (metric === 'deleteRate') return 0.95;
          return 0.50;
        },
      };

      expect(evaluatePromotionChannelEligibility({
        scoringEnabled: true,
        channel: {
          channelId: 'p90-explore',
          participantsCount: 1000,
          deletedCount: 10,
          successMsgCount: 10,
          failureMsgCount: 0,
          canSendMsgs: true,
        },
        percentiles,
        random: () => 0.05,
      })).toEqual({ eligible: true, reason: null });
    });
  });

  describe('calculatePromotionBatchLimit', () => {
    it('reduces healthy premium batch size and expands degraded batch size', () => {
      expect(calculatePromotionBatchLimit({
        scoringEnabled: true,
        daysLeft: 1,
        successCount: 9,
        failedCount: 1,
        failStreak: 0,
      }).limit).toBe(105);

      expect(calculatePromotionBatchLimit({
        scoringEnabled: true,
        daysLeft: 1,
        successCount: 1,
        failedCount: 9,
        failStreak: 6,
      }).limit).toBe(182);
    });

    it('keeps legacy non-scoring batch ranges and non-premium scoring throttle deterministic', () => {
      expect(calculatePromotionBatchLimit({
        scoringEnabled: false,
        daysLeft: 1,
        successCount: 0,
        failedCount: 0,
        failStreak: 0,
        random: () => 0.5,
      })).toMatchObject({ limit: 180, healthMultiplier: null });

      expect(calculatePromotionBatchLimit({
        scoringEnabled: false,
        daysLeft: 0,
        successCount: 0,
        failedCount: 0,
        failStreak: 0,
        random: () => 0.5,
      })).toMatchObject({ limit: 125, healthMultiplier: null });

      expect(calculatePromotionBatchLimit({
        scoringEnabled: true,
        daysLeft: 0,
        successCount: 8,
        failedCount: 2,
        failStreak: 0,
      })).toMatchObject({ limit: 168, healthMultiplier: 1.2 });
    });

    it('keeps malformed stats and random values inside safe batch bounds', () => {
      expect(calculatePromotionBatchLimit(null as unknown as Parameters<typeof calculatePromotionBatchLimit>[0]))
        .toMatchObject({ limit: 125, sessionRate: 0, healthMultiplier: null });

      expect(calculatePromotionBatchLimit({
        scoringEnabled: 'true' as unknown as boolean,
        daysLeft: 1,
        successCount: 10,
        failedCount: 0,
        failStreak: 0,
        random: () => 0.5,
      })).toMatchObject({ limit: 180, healthMultiplier: null });

      expect(calculatePromotionBatchLimit({
        scoringEnabled: false,
        daysLeft: Number.POSITIVE_INFINITY,
        successCount: Number.NaN,
        failedCount: -10,
        failStreak: Number.NaN,
        random: () => 99,
      })).toMatchObject({ limit: 150, sessionRate: 0, healthMultiplier: null });

      expect(calculatePromotionBatchLimit({
        scoringEnabled: true,
        daysLeft: 1,
        successCount: Number.NaN,
        failedCount: -10,
        failStreak: Number.POSITIVE_INFINITY,
        random: () => Number.NaN,
        includeJitter: true,
      })).toMatchObject({ limit: 192, sessionRate: 0, healthMultiplier: 1.3 });
    });
  });

  describe('calculateHealthBasedPromotionDelay', () => {
    it('returns deterministic healthy/degraded/normal delay bands with injected random', () => {
      expect(calculateHealthBasedPromotionDelay({
        successCount: 9,
        failedCount: 1,
        failStreak: 0,
        random: () => 0.5,
      })).toMatchObject({ delayMs: 14 * 60 * 1000, mode: 'healthy' });

      expect(calculateHealthBasedPromotionDelay({
        successCount: 1,
        failedCount: 9,
        failStreak: 6,
        random: () => 0.5,
      })).toMatchObject({ delayMs: 3 * 60 * 1000, mode: 'degraded' });

      expect(calculateHealthBasedPromotionDelay({
        successCount: 5,
        failedCount: 5,
        failStreak: 1,
        random: () => 0.5,
      })).toMatchObject({ delayMs: 8 * 60 * 1000, mode: 'normal' });
    });

    it('normalizes malformed delay stats and jitter randomness', () => {
      expect(calculateHealthBasedPromotionDelay(null as unknown as Parameters<typeof calculateHealthBasedPromotionDelay>[0]))
        .toMatchObject({ delayMs: 180000, sessionRate: 0, mode: 'degraded' });

      expect(calculateHealthBasedPromotionDelay({
        successCount: Number.NaN,
        failedCount: -1,
        failStreak: Number.POSITIVE_INFINITY,
        random: () => 99,
      })).toMatchObject({ delayMs: 239999, sessionRate: 0, mode: 'degraded' });

      expect(calculateFollowUpDelay(1_000, Number.NaN, () => 99)).toBe(1_000);
      expect(calculateFollowUpDelay(Number.NaN, 30_000, () => 0.5)).toBe(0);
    });
  });

  describe('selectPromotionMessageCandidates', () => {
    it('maps bandit strategies to ordered message candidates', () => {
      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        failStreak: 0,
        banditStrategy: 'ai_contextual',
      }).map((candidate) => candidate.kind)).toEqual(['ai', 'custom', 'fallback']);

      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        failStreak: 0,
        banditStrategy: ' legacy ' as any,
        availableMessageIds: ['2'],
      })).toEqual([
        { kind: 'legacy', randomIndex: '2', strategy: 'legacy' },
        { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
        { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
      ]);
    });

    it('keeps follow-up candidate behind word restriction and dm restriction policy', () => {
      expect(selectPromotionMessageCandidates({
        isFollowUp: true,
        wordRestriction: 2,
        dMRestriction: 0,
        deletedCount: 0,
        failStreak: 0,
      }).map((candidate) => candidate.kind)).toEqual(['followUp', 'fallback']);
    });

    it('uses the follow-up template for unrestricted follow-up sends', () => {
      expect(selectPromotionMessageCandidates({
        isFollowUp: true,
        wordRestriction: 0,
        dMRestriction: 0,
        deletedCount: 0,
        failStreak: 0,
        random: () => 0.99,
      }).map((candidate) => candidate.kind)).toEqual(['followUp', 'fallback']);
    });

    it('falls back to safe message choices when AI strategy is blocked by fail streak', () => {
      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        failStreak: 3,
        banditStrategy: 'ai_contextual',
      })).toEqual([
        { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
        { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
      ]);
    });

    it('ignores invalid bandit strategy values from JavaScript callers', () => {
      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        failStreak: 0,
        banditStrategy: 'bad_strategy' as any,
        random: () => 0.99,
      })).toEqual([
        { kind: 'ai', randomIndex: 'ai', strategy: 'ai_contextual' },
        { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
        { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
      ]);
    });

    it('uses fallback legacy message id when no available message ids exist', () => {
      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        wordRestriction: 1,
        deletedCount: 0,
        failStreak: 0,
        availableMessageIds: [],
      })[0]).toEqual({ kind: 'legacy', randomIndex: '0', strategy: 'legacy' });
    });

    it('prefers AI retry only for high deletion pressure before fail-streak suppression', () => {
      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        wordRestriction: 1,
        deletedCount: 21,
        failStreak: 2,
        availableMessageIds: ['7'],
      }).map((candidate) => candidate.kind)).toEqual(['ai', 'legacy', 'fallback']);
    });

    it('normalizes malformed restriction counters and random message index selection', () => {
      expect(selectPromotionMessageCandidates(null as unknown as Parameters<typeof selectPromotionMessageCandidates>[0]))
        .toEqual([
          { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
          { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
        ]);

      expect(selectPromotionMessageCandidates({
        isFollowUp: 'true' as unknown as boolean,
        dMRestriction: 0,
        failStreak: 0,
        random: () => 0.5,
      }).map((candidate) => candidate.kind)).toEqual(['custom', 'fallback']);

      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        wordRestriction: Number.NaN,
        deletedCount: -10,
        failStreak: Number.NaN,
        availableMessageIds: ['1', '2'],
        random: () => Number.NaN,
      }).map((candidate) => candidate.kind)).toEqual(['custom', 'fallback']);

      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        wordRestriction: 1,
        deletedCount: 0,
        failStreak: 0,
        availableMessageIds: ['1', '2'],
        random: () => 99,
      })[0]).toEqual({ kind: 'legacy', randomIndex: '2', strategy: 'legacy' });
    });

    it('filters malformed available message ids before picking legacy candidates', () => {
      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        wordRestriction: 1,
        deletedCount: 0,
        failStreak: 0,
        availableMessageIds: [' ', ' 7 ', '' as string],
        random: () => 0,
      })[0]).toEqual({ kind: 'legacy', randomIndex: '7', strategy: 'legacy' });

      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        wordRestriction: 1,
        deletedCount: 0,
        failStreak: 0,
        availableMessageIds: [' ', ''],
        random: () => 0,
      })[0]).toEqual({ kind: 'legacy', randomIndex: '0', strategy: 'legacy' });

      expect(selectPromotionMessageCandidates({
        isFollowUp: false,
        wordRestriction: 1,
        deletedCount: 0,
        failStreak: 0,
        availableMessageIds: '7' as unknown as string[],
        random: () => 0,
      })[0]).toEqual({ kind: 'legacy', randomIndex: '0', strategy: 'legacy' });
    });
  });

  describe('follow-up and deletion policy', () => {
    it('guards follow-up scheduling', () => {
      expect(evaluateFollowUpScheduling({ isFollowUp: true }).shouldSchedule).toBe(false);
      expect(evaluateFollowUpScheduling({ isFollowUp: false, daysLeft: 1 }).shouldSchedule).toBe(true);
      expect(calculateFollowUpDelay(15 * 60_000, 30_000, () => 0.5)).toBe(15 * 60_000);
    });

    it('returns specific negative follow-up reasons for operational debugging', () => {
      expect(evaluateFollowUpScheduling({ isFollowUp: false, isCleanedUp: true }))
        .toEqual({ shouldSchedule: false, reason: 'instance cleaned up' });
      expect(evaluateFollowUpScheduling({ isFollowUp: false, channelAvailable: false }))
        .toEqual({ shouldSchedule: false, reason: 'channel unavailable' });
      expect(evaluateFollowUpScheduling({
        isFollowUp: false,
        activeFollowUpCount: 10,
        maxFollowUpCount: 10,
      })).toEqual({ shouldSchedule: false, reason: 'follow-up cap reached' });
    });

    it('normalizes malformed follow-up premium and cap inputs', () => {
      expect(evaluateFollowUpScheduling(null as unknown as Parameters<typeof evaluateFollowUpScheduling>[0]))
        .toEqual({ shouldSchedule: false, reason: 'invalid follow-up input' });
      expect(evaluateFollowUpScheduling({
        isFollowUp: 'true' as unknown as boolean,
        daysLeft: 1,
      })).toEqual({ shouldSchedule: true, reason: null });

      expect(evaluateFollowUpScheduling({ isFollowUp: false, daysLeft: Number.NaN }))
        .toEqual({ shouldSchedule: true, reason: null });
      expect(evaluateFollowUpScheduling({ isFollowUp: false, daysLeft: 0 }))
        .toEqual({ shouldSchedule: true, reason: null });
      expect(evaluateFollowUpScheduling({
        isFollowUp: false,
        activeFollowUpCount: Number.NaN,
        maxFollowUpCount: Number.NaN,
      })).toEqual({ shouldSchedule: false, reason: 'follow-up cap reached' });
      expect(evaluateFollowUpScheduling({
        isFollowUp: false,
        activeFollowUpCount: -10,
        maxFollowUpCount: 1.9,
      })).toEqual({ shouldSchedule: true, reason: null });
    });

    it('clamps follow-up delay to zero when negative jitter exceeds base delay', () => {
      expect(calculateFollowUpDelay(1_000, 5_000, () => 0)).toBe(0);
    });

    it('maps message indexes to deletion actions and strategies', () => {
      expect(messageIndexToStrategy('ai')).toBe('ai_contextual');
      expect(messageIndexToStrategy(' ai ')).toBe('ai_contextual');
      expect(messageIndexToStrategy('followUp')).toBeNull();
      expect(evaluateDeletionPolicy(' followUp ').actions).toEqual(['increment_dm_restriction']);
      expect(evaluateDeletionPolicy(' ai ').actions).toEqual(['increment_word_restriction']);
      expect(evaluateDeletionPolicy(' custom ').actions).toEqual(['increment_word_restriction']);
      expect(evaluateDeletionPolicy(' 0 ', 1).actions).toEqual(['remove_message_index', 'ban_no_available_messages']);
      expect(evaluateDeletionPolicy('0', 2).actions).toEqual(['remove_message_index']);
      expect(evaluateDeletionPolicy('0', 0).actions).toEqual(['remove_message_index']);
      expect(evaluateDeletionPolicy('0', Number.NaN).actions).toEqual(['remove_message_index']);
    });
  });
});

import {
  DEFAULT_CHANNEL_DOC_STALE_AFTER_MS,
  classifyTelegramChannelError,
  computeLiveCanSendMsgs,
  deriveTelegramChannelLiveFacts,
  evaluateChannelPromotionHealth,
  evaluateChannelSendability,
  getChannelDocStaleness,
  mergeHydratedChannelFacts,
  normalizeChannelId,
  resolvePromotionFailureAction,
  shouldHydrateBeforeFinalReject,
} from '../src/channel-state';

describe('channel-state policy', () => {
  const now = Date.parse('2026-06-06T00:00:00.000Z');

  it('normalizes Telegram channel ids consistently', () => {
    expect(normalizeChannelId('-10012345')).toBe('12345');
    expect(normalizeChannelId('-12345')).toBe('12345');
    expect(normalizeChannelId(12345)).toBe('12345');
  });

  it('treats missing sendPlain/sendMessages as false but honors explicit bans', () => {
    expect(computeLiveCanSendMsgs({ channelId: '1', broadcast: false, restricted: false })).toBe(true);
    expect(computeLiveCanSendMsgs({ channelId: '1', defaultBannedRights: { sendPlain: true } })).toBe(false);
    expect(evaluateChannelSendability({ channelId: '1', canSendMsgs: false }).reason).toBe('canSendMsgs_false');
  });

  it('marks documents stale after thirty days or when critical fields are missing', () => {
    expect(getChannelDocStaleness({ channelId: '1' }, { now }).reason).toContain('missing_fields');

    const recent = now - DEFAULT_CHANNEL_DOC_STALE_AFTER_MS + 60_000;
    expect(getChannelDocStaleness({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      broadcast: false,
      restricted: false,
      private: false,
      forbidden: false,
      lastHydratedAt: recent,
    }, { now }).stale).toBe(false);

    const stale = now - DEFAULT_CHANNEL_DOC_STALE_AFTER_MS - 60_000;
    expect(getChannelDocStaleness({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      broadcast: false,
      restricted: false,
      private: false,
      forbidden: false,
      lastHydratedAt: stale,
    }, { now }).reason).toBe('older_than_30d');
  });

  it('keeps legacy fresh docs compatible by treating missing sendPlain as false and using updatedAt fallback', () => {
    const recent = now - 60_000;
    const result = getChannelDocStaleness({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      broadcast: false,
      restricted: false,
      private: false,
      forbidden: false,
      updatedAt: recent,
    }, { now });

    expect(result.stale).toBe(false);
    expect(result.lastHydratedAt).toBe(recent);
    expect(shouldHydrateBeforeFinalReject({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      broadcast: false,
      restricted: false,
      private: false,
      forbidden: false,
      updatedAt: recent,
    }, { now })).toBe(false);
  });

  it('requires hydration before a stale blocked doc can be finally rejected', () => {
    expect(shouldHydrateBeforeFinalReject({
      channelId: '1',
      banned: true,
      canSendMsgs: false,
      sendMessages: false,
      sendPlain: false,
      broadcast: false,
      restricted: false,
      private: false,
      forbidden: false,
      lastHydratedAt: now - DEFAULT_CHANNEL_DOC_STALE_AFTER_MS - 1,
    }, { now })).toBe(true);
  });

  it('requires hydration before rejecting a legacy blocked doc without live hydration timestamps', () => {
    expect(shouldHydrateBeforeFinalReject({
      channelId: '1',
      banned: true,
      canSendMsgs: false,
      sendMessages: false,
      broadcast: false,
      restricted: false,
      private: false,
      forbidden: false,
      updatedAt: now - 60_000,
    }, { now })).toBe(true);
  });

  it('clears stale metadata restriction flags when live Telegram facts are sendable', () => {
    const result = mergeHydratedChannelFacts(
      { channelId: '1', private: true, canSendMsgs: false },
      {
        channelId: '-1001',
        title: 'Fresh',
        username: 'fresh_group',
        participantsCount: 1000,
        broadcast: false,
        restricted: false,
        defaultBannedRights: {},
      },
      now,
    );

    expect(result.canSendMsgs).toBe(true);
    expect(result.clearedGlobalRestrictions).toBe(true);
    expect(result.patch.banned).toBe(false);
    expect(result.patch.canSendMsgs).toBe(true);
    expect(result.patch.lastHydrationReason).toBe('live_sendable');
  });

  it('clears stale banned flags when live Telegram facts are sendable', () => {
    const result = mergeHydratedChannelFacts(
      { channelId: '1', banned: true, canSendMsgs: false },
      {
        channelId: '-1001',
        title: 'Fresh',
        username: 'fresh_group',
        participantsCount: 1000,
        broadcast: false,
        restricted: false,
        defaultBannedRights: {},
      },
      now,
    );

    expect(result.canSendMsgs).toBe(true);
    expect(result.clearedGlobalRestrictions).toBe(true);
    expect(result.patch.banned).toBe(false);
    expect(result.patch.lastHydrationReason).toBe('live_sendable');
  });

  it('preserves global banned flags when live Telegram facts are blocked by sendPlain', () => {
    const result = mergeHydratedChannelFacts(
      { channelId: '1', banned: true, canSendMsgs: false },
      {
        channelId: '-1001',
        title: 'Fresh',
        username: 'fresh_group',
        participantsCount: 1000,
        broadcast: false,
        restricted: false,
        defaultBannedRights: { sendPlain: true },
      },
      now,
    );

    expect(result.canSendMsgs).toBe(false);
    expect(result.clearedGlobalRestrictions).toBe(false);
    expect(result.patch.banned).toBe(true);
    expect(result.patch.sendPlain).toBe(true);
    expect(result.patch.lastHydrationReason).toBe('sendPlain');
  });

  it('classifies reaction invalid and promotion flood as non-global channel restrictions', () => {
    expect(classifyTelegramChannelError(new Error('400: REACTION_INVALID')).shouldPersistGlobal).toBe(false);
    expect(classifyTelegramChannelError(new Error('400: REACTION_INVALID')).scope).toBe('reaction_cache');

    const flood = classifyTelegramChannelError(new Error('A wait of 3595 seconds is required before sending another message in this chat'));
    expect(flood.code).toBe('FLOOD_WAIT');
    expect(flood.waitSeconds).toBe(3595);
    expect(flood.shouldPausePromotionCycle).toBe(false);
    expect(flood.shouldPersistGlobal).toBe(false);

    expect(classifyTelegramChannelError('CHANNEL_RESTRICTED:payment_required').scope).toBe('account_channel');
    expect(classifyTelegramChannelError('CHANNEL_RESTRICTED:banned').shouldPersistGlobal).toBe(false);
    expect(classifyTelegramChannelError('CHANNEL_RESTRICTED:private').shouldPersistGlobal).toBe(true);
    expect(classifyTelegramChannelError('CHAT_WRITE_FORBIDDEN').shouldPersistGlobal).toBe(true);
    expect(classifyTelegramChannelError('CHAT_WRITE_FORBIDDEN').scope).toBe('global');
    expect(classifyTelegramChannelError('Telegram entity not found').reason).toBe('invalid');
  });

  it('scores exhausted and degraded channels without hard-banning them', () => {
    const result = evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: true,
      broadcast: false,
      restricted: false,
      private: false,
      forbidden: false,
      sendMessages: false,
      sendPlain: false,
      availableMsgs: [],
      participantsCount: 100,
      successMsgCount: 2,
      failureMsgCount: 1,
      deletedCount: 2,
      wordRestriction: 4,
    });

    expect(result.promotable).toBe(true);
    expect(result.score).toBe(50);
    expect(result.signals.contentHealth).toBe('exhausted');
    expect(result.signals.channelActivity).toBe('low');
  });

  it('classifies deletion health by sample window and delete-rate percentage', () => {
    const belowSampleWindow = evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      participantsCount: 1000,
      successMsgCount: 0,
      deletedCount: 4,
    });
    expect(belowSampleWindow.signals.deletionRate).toBe('low');

    const severeByRate = evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      participantsCount: 1000,
      successMsgCount: 0,
      deletedCount: 5,
    });
    expect(severeByRate.signals.deletionRate).toBe('severe');

    const moderateByRate = evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      participantsCount: 1000,
      successMsgCount: 6,
      deletedCount: 4,
    });
    expect(moderateByRate.signals.deletionRate).toBe('moderate');
  });

  it('uses fresh low-unique-user history as a strong activity penalty', () => {
    const result = evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      participantsCount: 5000,
      recentUniqueUsers: 7,
      lastUniqueUserCheckAt: now,
      now,
    });

    expect(result.promotable).toBe(false);
    expect(result.score).toBe(20);
    expect(result.signals.channelActivity).toBe('dead');

    expect(evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      participantsCount: 1000,
      recentUniqueUsers: 7,
      lastUniqueUserCheckAt: now,
      now,
    }).signals.channelActivity).toBe('active');

    expect(evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      participantsCount: 5000,
      recentUniqueUsers: 7,
      lastUniqueUserCheckAt: now - 31 * 24 * 60 * 60 * 1000,
      now,
    }).promotable).toBe(true);
  });

  it('blocks severe health scores while preserving probe eligibility for proven banned channels', () => {
    expect(evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: true,
      sendMessages: false,
      sendPlain: false,
      availableMsgs: [],
      participantsCount: 40,
      successMsgCount: 0,
      failureMsgCount: 9,
      deletedCount: 5,
      wordRestriction: 8,
    }).promotable).toBe(false);

    const probe = evaluateChannelPromotionHealth({
      channelId: '1',
      canSendMsgs: false,
      sendMessages: false,
      sendPlain: false,
      banned: true,
      bannedAt: now - 31 * 24 * 60 * 60 * 1000,
      successMsgCount: 3,
      deletedCount: 0,
      now,
    });

    expect(probe.promotable).toBe(false);
    expect(probe.probeEligible).toBe(true);
    expect(probe.reason).toBe('banned_probe_eligible');
    expect(probe.signals.sendability).toBe('pass');
  });

  it('resolves promotion failure persistence consistently', () => {
    const accountScopedBan = resolvePromotionFailureAction({ error: 'USER_BANNED_IN_CHANNEL', now });
    expect(accountScopedBan.scope).toBe('account_channel');
    expect(accountScopedBan.channelUpdate).toBeNull();
    expect(accountScopedBan.skipPersist).toBe(false);
    expect(resolvePromotionFailureAction('Telegram entity not found').channelUpdate).toEqual({
      forbidden: true,
      canSendMsgs: false,
    });
    expect(resolvePromotionFailureAction('FLOOD_WAIT_60').channelUpdate).toBeNull();
    expect(resolvePromotionFailureAction('TOPIC_CLOSED').channelUpdate).toBeNull();
    expect(resolvePromotionFailureAction('TOPIC_CLOSED').skipPersist).toBe(true);
  });

  it('derives live facts from default banned rights', () => {
    const facts = deriveTelegramChannelLiveFacts({
      channelId: '-10042',
      defaultBannedRights: { sendMessages: true, sendPlain: true },
    });

    expect(facts.channelId).toBe('42');
    expect(facts.sendMessages).toBe(true);
    expect(facts.sendPlain).toBe(true);
  });
});

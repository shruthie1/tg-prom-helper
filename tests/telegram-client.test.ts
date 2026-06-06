import { getTelegramChannelLiveFacts, getTelegramChannelMessageStats, getTelegramCommonChatIds } from '../src';

describe('telegram client adapters', () => {
  it('counts recent messages and unique users from a TelegramClient-like iterator', async () => {
    const now = Date.parse('2026-06-06T00:00:00.000Z');
    const client = {
      async *iterMessages() {
        yield { date: Math.floor((now - 60_000) / 1000), fromId: { userId: '1' }, message: 'hello' };
        yield { date: Math.floor((now - 120_000) / 1000), fromId: { userId: '2' }, message: 'promo' };
        yield { date: Math.floor((now - 25 * 60 * 60 * 1000) / 1000), fromId: { userId: '3' }, message: 'old' };
      },
    };

    const stats = await getTelegramChannelMessageStats(client, {
      channelId: '123',
      messageLimit: 100,
      regex: /promo/,
      now,
    });

    expect(stats.totalMessages).toBe(2);
    expect(stats.uniqueUsers).toBe(2);
    expect(stats.matchingMessages).toBe(1);
    expect([...stats.userIds]).toEqual(['1', '2']);
  });

  it('counts global regex matches independently per message', async () => {
    const client = {
      async *iterMessages() {
        yield { date: 1000, message: 'promo first', fromId: { userId: 1 } };
        yield { date: 1000, message: 'promo second', fromId: { userId: 2 } };
      },
    };
    const regex = /promo/g;

    const stats = await getTelegramChannelMessageStats(client, {
      channelId: '123',
      messageLimit: 2,
      regex,
      now: 1000 * 1000,
      lookbackMs: 1000,
    });

    expect(stats.matchingMessages).toBe(2);
    expect(regex.lastIndex).toBe(0);
  });

  it('hydrates channel live facts from a TelegramClient-like entity lookup', async () => {
    const client = {
      async getEntity(peer: unknown) {
        expect(peer).toBe('-100123');
        return {
          title: 'Promos',
          username: 'promo_channel',
          participantsCount: 700,
          restricted: false,
          broadcast: false,
          megagroup: true,
          defaultBannedRights: {
            sendMessages: false,
            sendPlain: false,
          },
          accessHash: BigInt(99),
        };
      },
    };

    const liveFacts = await getTelegramChannelLiveFacts(client, { channelId: '-100123' });

    expect(liveFacts).toEqual(expect.objectContaining({
      channelId: '123',
      title: 'Promos',
      username: 'promo_channel',
      participantsCount: 700,
      restricted: false,
      broadcast: false,
      sendMessages: false,
      sendPlain: false,
      canSendMsgs: true,
      megagroup: true,
      accessHash: '99',
    }));
  });

  it('uses a supplied entity and participant resolver without calling getEntity', async () => {
    const client = {
      async getEntity() {
        throw new Error('getEntity should not be called');
      },
    };

    const liveFacts = await getTelegramChannelLiveFacts(client, {
      channelId: '123',
      entity: {
        title: 'Read only',
        restricted: false,
        broadcast: false,
        defaultBannedRights: {
          sendMessages: true,
        },
      },
      resolveParticipantsCount: async (_entity, normalizedChannelId) => {
        expect(normalizedChannelId).toBe('123');
        return 1500;
      },
    });

    expect(liveFacts).toEqual(expect.objectContaining({
      channelId: '123',
      participantsCount: 1500,
      sendMessages: true,
      canSendMsgs: false,
    }));
  });

  it('marks forbidden Telegram entities as not sendable', async () => {
    const client = {
      async getEntity() {
        throw new Error('getEntity should not be called');
      },
    };

    const liveFacts = await getTelegramChannelLiveFacts(client, {
      channelId: '123',
      entity: {
        className: 'ChannelForbidden',
        title: 'Private promos',
        broadcast: false,
        megagroup: true,
        accessHash: '99',
      },
    });

    expect(liveFacts).toEqual(expect.objectContaining({
      channelId: '123',
      private: true,
      forbidden: true,
      canSendMsgs: false,
    }));
  });

  it('fetches normalized common chat ids from a TelegramClient-like invoker', async () => {
    const client = {
      async invoke(request: unknown) {
        expect((request as { className?: string }).className).toBe('messages.GetCommonChats');
        expect((request as { limit?: number }).limit).toBe(100);
        return {
          chats: [
            { id: '-100777' },
            { id: '888' },
            { id: '-100777' },
            { id: null },
          ],
        };
      },
    };

    const commonChatIds = await getTelegramCommonChatIds(client, { userId: '123' });

    expect(commonChatIds).toEqual(['777', '888']);
  });
});

import {
  DiscountedThompsonSampling,
  PromotionFlowRunner,
  PromotionMessageQueue,
  PromotionRunnerSupervisor,
  type PromotionFlowAdapter,
  type PromotionFlowRunnerOptions,
  type PromotionQueuedMessage,
} from '../src';
import { createPromotionRuntime } from '../src';
import {
  ChannelIntelligenceService,
  createDefaultIntelligence,
  type ChannelIntelligenceDocument,
} from '../src';
import type { PromotionChannelSnapshot, PromotionMessageCandidate } from '../src';

interface TestChannel extends PromotionChannelSnapshot {
  availableMsgs?: string[];
  wordRestriction?: number;
  dMRestriction?: number;
}

class Cursor<T> {
  constructor(private rows: T[]) {}
  sort(): Cursor<T> { return this; }
  limit(): Cursor<T> { return this; }
  async toArray(): Promise<T[]> { return this.rows; }
}

class CollectionMock<T extends { channelId: string }> {
  docs = new Map<string, T>();
  async findOne(filter: { channelId: string }): Promise<T | null> { return this.docs.get(filter.channelId) || null; }
  find(): Cursor<T> { return new Cursor(Array.from(this.docs.values())); }
  async findOneAndUpdate(filter: { channelId: string }, update: any): Promise<T | null> {
    const current = this.docs.get(filter.channelId);
    if (!current) return null;
    this.applyUpdate(current, update);
    return current;
  }
  async updateOne(filter: { channelId: string }, update: any): Promise<void> {
    let current = this.docs.get(filter.channelId);
    if (!current && update.$setOnInsert) {
      const inserted = update.$setOnInsert as T;
      current = inserted;
      this.docs.set(filter.channelId, inserted);
    }
    if (current) this.applyUpdate(current, update);
  }
  async createIndex(): Promise<void> {}
  aggregate(): Cursor<Record<string, unknown>> { return new Cursor([{ successRateValues: [], deleteRateValues: [] }]); }
  private applyUpdate(doc: any, update: any): void {
    for (const [path, value] of Object.entries(update.$inc || {})) {
      this.setPath(doc, path, (this.getPath(doc, path) || 0) + Number(value));
    }
    for (const [path, value] of Object.entries(update.$set || {})) this.setPath(doc, path, value);
  }
  private getPath(obj: any, path: string): any { return path.split('.').reduce((acc, key) => acc?.[key], obj); }
  private setPath(obj: any, path: string, value: unknown): void {
    const keys = path.split('.');
    let target = obj;
    for (const key of keys.slice(0, -1)) {
      target[key] = target[key] || {};
      target = target[key];
    }
    const lastKey = keys.at(-1);
    if (!lastKey) return;
    target[lastKey] = value;
  }
}

async function createAccount(collection: CollectionMock<ChannelIntelligenceDocument>) {
  (ChannelIntelligenceService as unknown as { instance: ChannelIntelligenceService | undefined }).instance = undefined;
  const runtime = await createPromotionRuntime({
    channelIntelligenceCollection: collection,
    activeChannelCollection: collection,
    redis: null,
    enablePercentiles: false,
    enableLocks: false,
    enableAttribution: false,
    warmPercentiles: false,
  });
  return runtime.createAccountContext({ mobile: '919100000001', clientId: 'client-a' });
}

describe('PromotionFlowRunner', () => {
  it('fails fast with clear errors for malformed constructor dependencies', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 1, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'unknown' }),
    };

    expect(() => new PromotionFlowRunner(null as unknown as PromotionFlowAdapter<TestChannel>, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
    })).toThrow('PromotionFlowRunner adapter is required');

    expect(() => new PromotionFlowRunner(adapter, null as unknown as PromotionFlowRunnerOptions))
      .toThrow('PromotionFlowRunner account context is required');
  });

  it('ignores malformed optional queue and bandit dependencies', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 1, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'unknown' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: true,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageQueue: {} as PromotionMessageQueue,
      bandit: {} as unknown as DiscountedThompsonSampling,
    });

    await runner.runOnce();

    expect(runner.getQueueSize()).toBe(0);
    runner.stop();
  });

  it('isolates throwing optional bandit selection and update from promotion flow', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('bandit-throws', createDefaultIntelligence('bandit-throws'));
    const account = await createAccount(collection);
    const warnings: string[] = [];
    const sent: PromotionMessageCandidate[] = [];
    const channel: TestChannel = {
      channelId: 'bandit-throws',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('bandit-throws')!],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => {
        sent.push(candidate);
        return { sent: true, messageId: 1, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'unknown' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };
    const throwingBandit = {
      selectArm: () => { throw new Error('bandit select down'); },
      update: () => { throw new Error('bandit update down'); },
    } as unknown as DiscountedThompsonSampling;

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: true,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      bandit: throwingBandit,
    });

    await runner.runOnce();

    expect(sent).toHaveLength(1);
    expect(runner.getQueueSize()).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion bandit strategy selection failed'),
      expect.stringContaining('Promotion bandit update failed'),
    ]));
    runner.stop();
  });

  it('owns channel selection, message candidate flow, queueing, and outcome recording', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1', createDefaultIntelligence('ch1'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch1',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sentCandidates: PromotionMessageCandidate[] = [];
    const existingMessages: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 3, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch1')!],
      getIntelligenceDoc: async () => collection.docs.get('ch1')!,
      sendPromotion: async ({ candidate }) => {
        sentCandidates.push(candidate);
        return { sent: true, messageId: 101, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      onMessageExisting: (message) => { existingMessages.push(message.channelId); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();
    expect(sentCandidates.length).toBe(1);
    expect(runner.getQueueSize()).toBe(1);
    await runner.checkQueuedMessages();
    expect(existingMessages).toEqual(['ch1']);
    expect(collection.docs.get('ch1')!.totalSendsToChannel).toBeGreaterThan(0);
    runner.stop();
  });

  it('isolates broken adapter logging from promotion execution', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch-log', createDefaultIntelligence('ch-log'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch-log',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch-log')!],
      getIntelligenceDoc: async () => collection.docs.get('ch-log')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 1001, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      log: () => { throw new Error('log sink down'); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await expect(runner.runOnce()).resolves.toBeUndefined();
    expect(sendAttempts).toBe(1);
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('keeps local success accounting when Redis post-send accounting fails', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1', createDefaultIntelligence('ch1'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch1',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const successEvents: string[] = [];
    const warnings: string[] = [];
    (account as any).isRecentlyPromoted = jest.fn().mockRejectedValue(new Error('redis down'));
    (account as any).recordSend = jest.fn().mockRejectedValue(new Error('redis down'));
    (account as any).markPromoted = jest.fn().mockRejectedValue(new Error('redis down'));

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch1')!],
      getIntelligenceDoc: async () => collection.docs.get('ch1')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 101, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      onSendSuccess: (sentChannel) => { successEvents.push(sentChannel.channelId); },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: true,
      attributionEnabled: true,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();
    expect(successEvents).toEqual(['ch1']);
    expect(runner.getQueueSize()).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion Redis lock check failed'),
      expect.stringContaining('Promotion attribution record failed after local success accounting'),
      expect.stringContaining('Promotion Redis lock record failed after local success accounting'),
    ]));
    runner.stop();
  });

  it('keeps local success accounting when intelligence success accounting fails', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1i', createDefaultIntelligence('ch1i'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch1i',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const successEvents: string[] = [];
    const warnings: string[] = [];
    (account as any).recordSuccess = jest.fn().mockRejectedValue(new Error('mongo write failed'));

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch1i')!],
      getIntelligenceDoc: async () => collection.docs.get('ch1i')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 103, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      onSendSuccess: (sentChannel) => { successEvents.push(sentChannel.channelId); },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();
    expect(successEvents).toEqual(['ch1i']);
    expect(runner.getQueueSize()).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion intelligence success record failed after local success accounting'),
    ]));
    runner.stop();
  });

  it('keeps local failure accounting when intelligence failure accounting fails', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1f', createDefaultIntelligence('ch1f'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch1f',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const failures: string[] = [];
    const warnings: string[] = [];
    (account as any).recordFailure = jest.fn().mockRejectedValue(new Error('mongo write failed'));

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch1f')!],
      getIntelligenceDoc: async () => collection.docs.get('ch1f')!,
      sendPromotion: async ({ candidate }) => ({
        sent: false,
        messageIndex: candidate.randomIndex,
        errorMessage: 'CHAT_WRITE_FORBIDDEN',
        terminal: true,
      }),
      checkMessage: async () => ({ status: 'exists' }),
      onSendFailure: (_channel, errorMessage) => { failures.push(errorMessage); },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();
    expect(failures).toEqual(['CHAT_WRITE_FORBIDDEN']);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion intelligence failure record failed after local failure accounting'),
    ]));
    runner.stop();
  });

  it('isolates send-success hook failures from attribution and lock accounting', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1b', createDefaultIntelligence('ch1b'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch1b',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const warnings: string[] = [];
    const recordSend = jest.fn().mockResolvedValue(undefined);
    const markPromoted = jest.fn().mockResolvedValue(undefined);
    (account as any).recordSend = recordSend;
    (account as any).markPromoted = markPromoted;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch1b')!],
      getIntelligenceDoc: async () => collection.docs.get('ch1b')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 102, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      onSendSuccess: () => { throw new Error('metrics sink down'); },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: true,
      attributionEnabled: true,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(recordSend).toHaveBeenCalledWith('ch1b');
    expect(markPromoted).toHaveBeenCalledWith('ch1b');
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion adapter hook failed; hook=onSendSuccess'),
    ]));
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('treats sent-without-message-id as terminal success without duplicate fallback sends', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1d', createDefaultIntelligence('ch1d'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch1d',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sentCandidates: PromotionMessageCandidate[] = [];
    const warnings: string[] = [];
    const successes: Array<{ messageId: number | undefined; messageIndex: string }> = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch1d')!],
      getIntelligenceDoc: async () => collection.docs.get('ch1d')!,
      sendPromotion: async ({ candidate }) => {
        sentCandidates.push(candidate);
        return { sent: true, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      onSendSuccess: (_channel, result) => {
        successes.push({ messageId: result.messageId, messageIndex: result.messageIndex });
      },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sentCandidates).toHaveLength(1);
    expect(successes).toEqual([{ messageId: undefined, messageIndex: sentCandidates[0]!.randomIndex }]);
    expect(runner.getQueueSize()).toBe(0);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion send returned without messageId'),
    ]));
    runner.stop();
  });

  it('normalizes invalid sent message ids before success hooks and follow-up checks', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch-invalid-id', createDefaultIntelligence('ch-invalid-id'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch-invalid-id',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const warnings: string[] = [];
    const successes: number[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch-invalid-id')!],
      getIntelligenceDoc: async () => collection.docs.get('ch-invalid-id')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: Number.NaN, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      onSendSuccess: (_channel, result) => { successes.push(result.messageId ?? -1); },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(successes).toEqual([-1]);
    expect(runner.getQueueSize()).toBe(0);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion send returned without messageId'),
    ]));
    runner.stop();
  });


  it('retains queued messages for retry when Telegram message checks are unknown', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1', createDefaultIntelligence('ch1'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch1',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const existingMessages: string[] = [];
    let checkStatus: 'unknown' | 'exists' = 'unknown';
    let checkCount = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch1')!],
      getIntelligenceDoc: async () => collection.docs.get('ch1')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 101, messageIndex: candidate.randomIndex }),
      checkMessage: async () => {
        checkCount++;
        return { status: checkStatus };
      },
      onMessageExisting: (message) => { existingMessages.push(message.channelId); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 60_000,
      followUpJitterMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();
    expect(runner.getQueueSize()).toBe(1);

    await runner.checkQueuedMessages();
    expect(checkCount).toBe(1);
    expect(runner.getQueueSize()).toBe(1);
    expect(existingMessages).toEqual([]);

    checkStatus = 'exists';
    await runner.checkQueuedMessages();
    expect(checkCount).toBe(2);
    expect(runner.getQueueSize()).toBe(0);
    expect(existingMessages).toEqual(['ch1']);
    runner.stop();
  });

  it('retains queued messages for retry when Telegram message checks throw', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'queued-throw',
      messageId: 11,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    const warnings: string[] = [];
    let checks = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 11, messageIndex: candidate.randomIndex }),
      checkMessage: async () => {
        checks++;
        if (checks === 1) throw new Error('MESSAGE_ID_INVALID');
        return { status: 'exists' };
      },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      messageQueue,
    });

    await runner.checkQueuedMessages();
    expect(runner.getQueueSize()).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion message check failed; retaining for retry'),
    ]));

    await runner.checkQueuedMessages();
    expect(runner.getQueueSize()).toBe(0);
    runner.stop();
  });

  it('isolates message-existing and follow-up-scheduled hook failures from queue completion', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1c', createDefaultIntelligence('ch1c'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch1c',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const warnings: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch1c')!],
      getIntelligenceDoc: async () => collection.docs.get('ch1c')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 103, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      onMessageExisting: () => { throw new Error('existing observer down'); },
      onFollowUpScheduled: async () => { throw new Error('scheduler observer down'); },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 60_000,
      followUpJitterMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();
    expect(runner.getQueueSize()).toBe(1);

    await runner.checkQueuedMessages();
    expect(runner.getQueueSize()).toBe(0);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion adapter hook failed; hook=onMessageExisting'),
      expect.stringContaining('Promotion adapter hook failed; hook=onFollowUpScheduled'),
    ]));
    runner.stop();
  });

  it('records failed candidate metrics against the actual message strategy', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch2', createDefaultIntelligence('ch2'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch2',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sentCandidates: PromotionMessageCandidate[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 3, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch2')!],
      getIntelligenceDoc: async () => collection.docs.get('ch2')!,
      sendPromotion: async ({ candidate }) => {
        sentCandidates.push(candidate);
        if (candidate.kind === 'custom') {
          return { sent: false, messageIndex: candidate.randomIndex, errorMessage: 'CUSTOM_FAIL' };
        }
        return { sent: true, messageId: 202, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sentCandidates.map((candidate) => candidate.kind)).toEqual(['custom', 'fallback']);
    const doc = collection.docs.get('ch2')!;
    expect(doc.strategies.natural_template.f).toBe(1);
    expect(doc.strategies.natural_template.n).toBe(1);
    expect(doc.strategies.legacy.f).toBe(0);
    expect(doc.strategies.legacy.s).toBe(1);
    runner.stop();
  });

  it('penalizes the selected bandit strategy when a send candidate fails', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch2-bandit-fail', createDefaultIntelligence('ch2-bandit-fail'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch2-bandit-fail',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const updates: Array<{ strategy: string; reward: 0 | 1 }> = [];
    const bandit = {
      selectArm: () => 'natural_template',
      update: (strategy: string, reward: 0 | 1) => { updates.push({ strategy, reward }); },
    } as unknown as DiscountedThompsonSampling;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 3, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch2-bandit-fail')!],
      getIntelligenceDoc: async () => collection.docs.get('ch2-bandit-fail')!,
      sendPromotion: async ({ candidate }) => {
        if (candidate.kind === 'custom') {
          return { sent: false, messageIndex: candidate.randomIndex, errorMessage: 'CUSTOM_FAIL' };
        }
        return { sent: true, messageId: 203, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: true,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      bandit,
    });

    await runner.runOnce();

    expect(updates).toEqual([
      { strategy: 'natural_template', reward: 0 },
      { strategy: 'legacy', reward: 1 },
    ]);
    runner.stop();
  });

  it('records successful custom-slot sends against the materialized template strategy', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch2-bandit-success', createDefaultIntelligence('ch2-bandit-success'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch2-bandit-success',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const updates: Array<{ strategy: string; reward: 0 | 1 }> = [];
    const sentCandidates: PromotionMessageCandidate[] = [];
    const bandit = {
      selectArm: () => ({ strategy: 'markov_chain', sample: 0.9 }),
      update: (strategy: string, reward: 0 | 1) => { updates.push({ strategy, reward }); },
    } as unknown as DiscountedThompsonSampling;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch2-bandit-success')!],
      getIntelligenceDoc: async () => collection.docs.get('ch2-bandit-success')!,
      sendPromotion: async ({ candidate }) => {
        sentCandidates.push(candidate);
        return { sent: true, messageId: 204, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: true,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      bandit,
    });

    await runner.runOnce();

    expect(sentCandidates[0]).toEqual(expect.objectContaining({
      kind: 'custom',
      randomIndex: 'custom',
      strategy: 'natural_template',
    }));
    const doc = collection.docs.get('ch2-bandit-success')!;
    expect(doc.strategies.markov_chain.s).toBe(0);
    expect(doc.strategies.markov_chain.n).toBe(0);
    expect(doc.strategies.natural_template.s).toBe(1);
    expect(updates).toEqual([{ strategy: 'natural_template', reward: 1 }]);
    runner.stop();
  });

  it('records custom-slot deletions against the queued materialized template strategy', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch2-bandit-deleted', createDefaultIntelligence('ch2-bandit-deleted'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch2-bandit-deleted',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0', '1', '2'],
    };
    const updates: Array<{ strategy: string; reward: 0 | 1 }> = [];
    const bandit = {
      selectArm: () => ({ strategy: 'question_doubt', sample: 0.9 }),
      update: (strategy: string, reward: 0 | 1) => { updates.push({ strategy, reward }); },
    } as unknown as DiscountedThompsonSampling;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch2-bandit-deleted')!],
      getIntelligenceDoc: async () => collection.docs.get('ch2-bandit-deleted')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 205, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'deleted' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: true,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      bandit,
    });

    await runner.runOnce();
    await runner.checkQueuedMessages();

    const doc = collection.docs.get('ch2-bandit-deleted')!;
    expect(doc.strategies.question_doubt.s).toBe(0);
    expect(doc.strategies.question_doubt.f).toBe(0);
    expect(doc.strategies.question_doubt.n).toBe(0);
    expect(doc.strategies.natural_template.s).toBe(1);
    expect(doc.strategies.natural_template.f).toBe(1);
    expect(doc.strategies.natural_template.n).toBe(2);
    expect(updates).toEqual([
      { strategy: 'natural_template', reward: 1 },
      { strategy: 'natural_template', reward: 0 },
    ]);
    expect(runner.getQueueSize()).toBe(0);
    runner.stop();
  });

  it('converts thrown adapter sends into terminal candidate failures', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch2b', createDefaultIntelligence('ch2b'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch2b',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sentCandidates: PromotionMessageCandidate[] = [];
    const failures: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 3, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch2b')!],
      getIntelligenceDoc: async () => collection.docs.get('ch2b')!,
      sendPromotion: async ({ candidate }) => {
        sentCandidates.push(candidate);
        if (candidate.kind === 'custom') {
          throw new Error('CUSTOM_THROW');
        }
        return { sent: true, messageId: 212, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      onSendFailure: (_channel, errorMessage) => { failures.push(errorMessage); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sentCandidates.map((candidate) => candidate.kind)).toEqual(['custom']);
    expect(failures).toEqual(['CUSTOM_THROW']);
    expect(runner.getQueueSize()).toBe(0);
    const doc = collection.docs.get('ch2b')!;
    expect(doc.strategies.natural_template.f).toBe(1);
    expect(doc.strategies.legacy.s).toBe(0);
    runner.stop();
  });

  it('continues to fallback candidates without recording failure when a candidate has no sendable content', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch2c', createDefaultIntelligence('ch2c'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch2c',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sentCandidates: PromotionMessageCandidate[] = [];
    const failures: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 3, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch2c')!],
      getIntelligenceDoc: async () => collection.docs.get('ch2c')!,
      sendPromotion: async ({ candidate }) => {
        sentCandidates.push(candidate);
        if (candidate.kind === 'custom') {
          return { sent: false, messageIndex: candidate.randomIndex };
        }
        return { sent: true, messageId: 213, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      onSendFailure: (_channel, errorMessage) => { failures.push(errorMessage); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sentCandidates.map((candidate) => candidate.kind)).toEqual(['custom', 'fallback']);
    expect(failures).toEqual([]);
    const doc = collection.docs.get('ch2c')!;
    expect(doc.strategies.natural_template.f).toBe(0);
    expect(doc.strategies.legacy.s).toBe(1);
    runner.stop();
  });

  it('exhausts candidates without queueing when no candidate has sendable content', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch2d', createDefaultIntelligence('ch2d'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch2d',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sentCandidates: PromotionMessageCandidate[] = [];
    const warnings: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 3, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch2d')!],
      getIntelligenceDoc: async () => collection.docs.get('ch2d')!,
      sendPromotion: async ({ candidate }) => {
        sentCandidates.push(candidate);
        return { sent: false, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sentCandidates.map((candidate) => candidate.kind)).toEqual(['custom', 'fallback']);
    expect(runner.getQueueSize()).toBe(0);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion exhausted candidates without send'),
    ]));
    runner.stop();
  });

  it('falls back to legacy eligibility when percentile loading fails during scoring mode', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch2e', createDefaultIntelligence('ch2e'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch2e',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const warnings: string[] = [];
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch2e')!],
      getIntelligenceDoc: async () => collection.docs.get('ch2e')!,
      getPercentiles: async () => { throw new Error('percentile redis down'); },
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 214, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: true,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sendAttempts).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion percentile load failed; using legacy eligibility'),
    ]));
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('records deleted messages with deletion policy and removes them from the queue', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch3', createDefaultIntelligence('ch3'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch3',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const deletedActions: string[][] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 3, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch3')!],
      getIntelligenceDoc: async () => collection.docs.get('ch3')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 303, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'deleted' }),
      onMessageDeleted: (_message, policy) => { deletedActions.push(policy.actions); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();
    expect(runner.getQueueSize()).toBe(1);

    await runner.checkQueuedMessages();
    expect(runner.getQueueSize()).toBe(0);
    expect(deletedActions).toEqual([['increment_word_restriction']]);
    const doc = collection.docs.get('ch3')!;
    expect(doc.strategies.natural_template.s).toBe(1);
    expect(doc.strategies.natural_template.f).toBe(1);
    expect(doc.strategies.natural_template.n).toBe(2);
    runner.stop();
  });

  it('fires follow-up timers through the guarded helper flow', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch4', createDefaultIntelligence('ch4'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch4',
      participantsCount: 1000,
      canSendMsgs: true,
      wordRestriction: 1,
      dMRestriction: 0,
      availableMsgs: ['0'],
    };
    const sent: Array<{ kind: string; isFollowUp: boolean }> = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch4')!],
      getIntelligenceDoc: async () => collection.docs.get('ch4')!,
      sendPromotion: async ({ candidate, isFollowUp }) => {
        sent.push({ kind: candidate.kind, isFollowUp });
        return { sent: true, messageId: isFollowUp ? 405 : 404, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 0,
      followUpJitterMs: 0,
      channelLoopDelayMs: 0,
    });

    try {
      await runner.runOnce();
      await runner.checkQueuedMessages();
      expect(sent).toEqual([{ kind: 'legacy', isFollowUp: false }]);

      await jest.runOnlyPendingTimersAsync();

      expect(sent).toEqual([
        { kind: 'legacy', isFollowUp: false },
        { kind: 'followUp', isFollowUp: true },
      ]);
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('treats pending follow-up timers as in-flight promotion work for channel eligibility', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('pending-followup-channel', createDefaultIntelligence('pending-followup-channel'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'pending-followup-channel',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sent: Array<{ messageId: number; isFollowUp: boolean }> = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('pending-followup-channel')!],
      getIntelligenceDoc: async () => collection.docs.get('pending-followup-channel')!,
      sendPromotion: async ({ candidate, isFollowUp }) => {
        const messageId = sent.length + 700;
        sent.push({ messageId, isFollowUp });
        return { sent: true, messageId, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 60_000,
      followUpJitterMs: 0,
      channelLoopDelayMs: 0,
    });

    try {
      await runner.runOnce();
      await runner.checkQueuedMessages();
      await runner.runOnce();

      expect(sent).toEqual([{ messageId: 700, isFollowUp: false }]);
      expect(runner.getQueueSize()).toBe(0);
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('does not schedule follow-up when premium days are exhausted', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch4b', createDefaultIntelligence('ch4b'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch4b',
      participantsCount: 1000,
      canSendMsgs: true,
      wordRestriction: 1,
      dMRestriction: 0,
      availableMsgs: ['0'],
    };
    const sent: Array<{ kind: string; isFollowUp: boolean }> = [];
    const scheduledFollowUps: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 0 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch4b')!],
      getIntelligenceDoc: async () => collection.docs.get('ch4b')!,
      sendPromotion: async ({ candidate, isFollowUp }) => {
        sent.push({ kind: candidate.kind, isFollowUp });
        return { sent: true, messageId: isFollowUp ? 415 : 414, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      onFollowUpScheduled: (message) => { scheduledFollowUps.push(message.channelId); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 0,
      followUpJitterMs: 0,
      channelLoopDelayMs: 0,
    });

    try {
      await runner.runOnce();
      await runner.checkQueuedMessages();
      await jest.runOnlyPendingTimersAsync();

      expect(sent).toEqual([{ kind: 'legacy', isFollowUp: false }]);
      expect(scheduledFollowUps).toEqual([]);
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('skips a scheduled follow-up if premium expires before execution', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'expires-before-followup',
      messageId: 601,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    let statsCalls = 0;
    let followUpSends = 0;
    let getChannelCalls = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => {
        statsCalls++;
        return { successCount: 0, failedCount: 0, failStreak: 0, daysLeft: statsCalls === 1 ? 1 : 0 };
      },
      loadChannels: async () => [],
      getChannel: async () => {
        getChannelCalls++;
        return {
          channelId: 'expires-before-followup',
          participantsCount: 1000,
          canSendMsgs: true,
          availableMsgs: ['0'],
        };
      },
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ isFollowUp, candidate }) => {
        if (isFollowUp) followUpSends++;
        return { sent: true, messageId: 602, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 0,
      followUpJitterMs: 0,
      channelLoopDelayMs: 0,
      messageQueue,
    });

    try {
      await runner.checkQueuedMessages();
      await jest.runOnlyPendingTimersAsync();

      expect(statsCalls).toBe(2);
      expect(getChannelCalls).toBe(0);
      expect(followUpSends).toBe(0);
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('caps active follow-up timers when maxFollowUpCount is configured', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'cap-1',
      messageId: 501,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    messageQueue.enqueue({
      channelId: 'cap-2',
      messageId: 502,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    const scheduledFollowUps: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 501, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      onFollowUpScheduled: (message) => { scheduledFollowUps.push(message.channelId); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 60_000,
      followUpJitterMs: 0,
      maxFollowUpCount: 1,
      channelLoopDelayMs: 0,
      messageQueue,
    });

    try {
      await runner.checkQueuedMessages();
      expect(scheduledFollowUps).toEqual(['cap-1']);
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('skips selected channels when shouldContinue returns false before send', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch4c', createDefaultIntelligence('ch4c'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch4c',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      shouldContinue: () => false,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch4c')!],
      getIntelligenceDoc: async () => collection.docs.get('ch4c')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 416, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sendAttempts).toBe(0);
    expect(runner.getQueueSize()).toBe(0);
    runner.stop();
  });

  it('skips selected channels when the adapter is inactive before send', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch4d', createDefaultIntelligence('ch4d'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch4d',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => false,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch4d')!],
      getIntelligenceDoc: async () => collection.docs.get('ch4d')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 417, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sendAttempts).toBe(0);
    expect(runner.getQueueSize()).toBe(0);
    runner.stop();
  });

  it('treats malformed active and continuation return values as stopped', async () => {
    async function runCase(overrides: Partial<PromotionFlowAdapter<TestChannel>>) {
      const collection = new CollectionMock<ChannelIntelligenceDocument>();
      collection.docs.set('malformed-active', createDefaultIntelligence('malformed-active'));
      const account = await createAccount(collection);
      const channel: TestChannel = {
        channelId: 'malformed-active',
        participantsCount: 1000,
        canSendMsgs: true,
        availableMsgs: ['0'],
      };
      let sendAttempts = 0;

      const adapter: PromotionFlowAdapter<TestChannel> = {
        isActive: () => true,
        getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
        loadChannels: async () => [channel],
        getChannel: async () => channel,
        getIntelligenceDocs: async () => [collection.docs.get('malformed-active')!],
        getIntelligenceDoc: async () => collection.docs.get('malformed-active')!,
        sendPromotion: async ({ candidate }) => {
          sendAttempts++;
          return { sent: true, messageId: 1300, messageIndex: candidate.randomIndex };
        },
        checkMessage: async () => ({ status: 'exists' }),
        sleep: async () => {},
        ...overrides,
      };

      const runner = new PromotionFlowRunner(adapter, {
        account,
        scoringEnabled: false,
        messageBanditEnabled: false,
        redisLockEnabled: false,
        attributionEnabled: false,
        batchTarget: 1,
        messageCheckDelayMs: 0,
        channelLoopDelayMs: 0,
      });

      await runner.runOnce();
      runner.stop();
      return sendAttempts;
    }

    await expect(runCase({ isActive: () => 'false' as unknown as boolean }))
      .resolves.toBe(0);
    await expect(runCase({ shouldContinue: () => 'true' as unknown as boolean }))
      .resolves.toBe(0);
  });

  it('stops the current cycle when per-channel active or continuation checks throw', async () => {
    async function runCase(
      channelId: string,
      overrides: Partial<PromotionFlowAdapter<TestChannel>>,
      expectedWarning: string,
    ) {
      const collection = new CollectionMock<ChannelIntelligenceDocument>();
      collection.docs.set(channelId, createDefaultIntelligence(channelId));
      const account = await createAccount(collection);
      const channel: TestChannel = {
        channelId,
        participantsCount: 1000,
        canSendMsgs: true,
        availableMsgs: ['0'],
      };
      const warnings: string[] = [];
      let sendAttempts = 0;

      const adapter: PromotionFlowAdapter<TestChannel> = {
        isActive: () => true,
        getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
        loadChannels: async () => [channel],
        getChannel: async () => channel,
        getIntelligenceDocs: async () => [collection.docs.get(channelId)!],
        getIntelligenceDoc: async () => collection.docs.get(channelId)!,
        sendPromotion: async ({ candidate }) => {
          sendAttempts++;
          return { sent: true, messageId: 1301, messageIndex: candidate.randomIndex };
        },
        checkMessage: async () => ({ status: 'exists' }),
        log: (level, message) => {
          if (level === 'warn') warnings.push(message);
        },
        sleep: async () => {},
        ...overrides,
      };

      const runner = new PromotionFlowRunner(adapter, {
        account,
        scoringEnabled: false,
        messageBanditEnabled: false,
        redisLockEnabled: false,
        attributionEnabled: false,
        batchTarget: 1,
        messageCheckDelayMs: 0,
        channelLoopDelayMs: 0,
      });

      await expect(runner.runOnce()).resolves.toBeUndefined();
      expect(sendAttempts).toBe(0);
      expect(warnings).toEqual(expect.arrayContaining([
        expect.stringContaining(expectedWarning),
      ]));
      runner.stop();
    }

    await runCase('active-throws', {
      isActive: () => { throw new Error('active probe down'); },
    }, 'active check failed');
    await runCase('continue-throws', {
      shouldContinue: () => { throw new Error('continue probe down'); },
    }, 'shouldContinue check failed');
  });

  it('continues eligibility checks when adapter recent-queue signal fails', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('recent-queue-throws', createDefaultIntelligence('recent-queue-throws'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'recent-queue-throws',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const warnings: string[] = [];
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      isRecentlyQueued: () => { throw new Error('queue cache down'); },
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('recent-queue-throws')!],
      getIntelligenceDoc: async () => collection.docs.get('recent-queue-throws')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 1302, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sendAttempts).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion adapter recent-queue check failed'),
    ]));
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('guards follow-up execution when the adapter stops, shouldContinue stops, or channel lookup disappears', async () => {
    jest.useFakeTimers();
    const sent: string[] = [];

    async function runGuardedFollowUpCase(
      channelId: string,
      configureAfterSchedule: (state: { active: boolean; shouldContinue: boolean; channelAvailable: boolean }) => void,
    ) {
      const collection = new CollectionMock<ChannelIntelligenceDocument>();
      collection.docs.set(channelId, createDefaultIntelligence(channelId));
      const account = await createAccount(collection);
      const state = { active: true, shouldContinue: true, channelAvailable: true };
      const channel: TestChannel = {
        channelId,
        participantsCount: 1000,
        canSendMsgs: true,
        wordRestriction: 1,
        dMRestriction: 0,
        availableMsgs: ['0'],
      };

      const adapter: PromotionFlowAdapter<TestChannel> = {
        isActive: () => state.active,
        shouldContinue: () => state.shouldContinue,
        getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
        loadChannels: async () => [channel],
        getChannel: async () => (state.channelAvailable ? channel : null),
        getIntelligenceDocs: async () => [collection.docs.get(channelId)!],
        getIntelligenceDoc: async () => collection.docs.get(channelId)!,
        sendPromotion: async ({ candidate, isFollowUp }) => {
          sent.push(`${channelId}:${candidate.kind}:${isFollowUp}`);
          return { sent: true, messageId: isFollowUp ? 419 : 418, messageIndex: candidate.randomIndex };
        },
        checkMessage: async () => ({ status: 'exists' }),
        sleep: async () => {},
      };

      const runner = new PromotionFlowRunner(adapter, {
        account,
        scoringEnabled: false,
        messageBanditEnabled: false,
        redisLockEnabled: false,
        attributionEnabled: false,
        batchTarget: 1,
        messageCheckDelayMs: 0,
        followUpDelayMs: 0,
        followUpJitterMs: 0,
        channelLoopDelayMs: 0,
      });

      await runner.runOnce();
      await runner.checkQueuedMessages();
      configureAfterSchedule(state);
      await jest.runOnlyPendingTimersAsync();
      runner.stop();
    }

    try {
      await runGuardedFollowUpCase('ch4e', (state) => { state.active = false; });
      await runGuardedFollowUpCase('ch4f', (state) => { state.shouldContinue = false; });
      await runGuardedFollowUpCase('ch4h', (state) => { state.channelAvailable = false; });

      expect(sent).toEqual([
        'ch4e:legacy:false',
        'ch4f:legacy:false',
        'ch4h:legacy:false',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('normalizes unexpected follow-up execution errors before logging', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch4i', createDefaultIntelligence('ch4i'));
    const account = await createAccount(collection);
    const logs: string[] = [];
    const channel: TestChannel = {
      channelId: 'ch4i',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      shouldContinue: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => { throw { code: 'FOLLOWUP_FAIL' }; },
      getIntelligenceDocs: async () => [collection.docs.get('ch4i')!],
      getIntelligenceDoc: async () => collection.docs.get('ch4i')!,
      sendPromotion: async ({ candidate, isFollowUp }) => ({
        sent: true,
        messageId: isFollowUp ? 420 : 419,
        messageIndex: candidate.randomIndex,
      }),
      checkMessage: async () => ({ status: 'exists' }),
      log: (_level, message) => { logs.push(message); },
      sleep: async () => {},
    };
    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 0,
      followUpJitterMs: 0,
      channelLoopDelayMs: 0,
    });

    try {
      await runner.runOnce();
      await runner.checkQueuedMessages();
      await jest.runOnlyPendingTimersAsync();

      expect(logs).toContain('Follow-up failed for ch4i: {"code":"FOLLOWUP_FAIL"}');
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('serializes overlapping queue checks so Telegram message checks are not duplicated', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'queued',
      messageId: 1,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    let resolveCheck: () => void = () => undefined;
    let checkCount = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 1, messageIndex: candidate.randomIndex }),
      checkMessage: async () => {
        checkCount++;
        await new Promise<void>((resolve) => { resolveCheck = resolve; });
        return { status: 'exists' };
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      messageQueue,
    });

    const firstCheck = runner.checkQueuedMessages();
    const secondCheck = runner.checkQueuedMessages();
    await Promise.resolve();
    expect(checkCount).toBe(1);
    resolveCheck();
    await Promise.all([firstCheck, secondCheck]);

    expect(runner.getQueueSize()).toBe(0);
    runner.stop();
  });

  it('normalizes malformed externally owned queue output and isolates remove failures', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const checkedMessages: Array<{ channelId: string; messageIndex: string; isFollowUp: boolean }> = [];
    const warnings: string[] = [];
    const externalQueue = {
      size: 3,
      enqueue: () => undefined,
      isQueued: () => false,
      readyForCheck: () => [
        null,
        { channelId: '   ', messageId: 10 },
        {
          channelId: ' external ',
          messageId: 1201,
          messageIndex: ' 0 ',
          timestamp: Number.NaN,
          isFollowUp: 'true',
          availableMessageCount: Number.NaN,
        },
      ],
      remove: () => { throw new Error('queue remove failed'); },
    } as unknown as PromotionMessageQueue;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 1, messageIndex: candidate.randomIndex }),
      checkMessage: async (message) => {
        checkedMessages.push({
          channelId: message.channelId,
          messageIndex: message.messageIndex,
          isFollowUp: message.isFollowUp,
        });
        return { status: 'exists' };
      },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      messageQueue: externalQueue,
    });

    await expect(runner.checkQueuedMessages()).resolves.toBeUndefined();

    expect(checkedMessages).toEqual([{ channelId: 'external', messageIndex: '0', isFollowUp: false }]);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion queue remove failed'),
    ]));
    runner.stop();
  });

  it('breaks a started promotion cycle between channels when stopped during delay', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch4g-a', createDefaultIntelligence('ch4g-a'));
    collection.docs.set('ch4g-b', createDefaultIntelligence('ch4g-b'));
    const account = await createAccount(collection);
    const channels: TestChannel[] = [
      { channelId: 'ch4g-a', participantsCount: 1000, canSendMsgs: true, availableMsgs: ['0'] },
      { channelId: 'ch4g-b', participantsCount: 1000, canSendMsgs: true, availableMsgs: ['0'] },
    ];
    const sentChannels: string[] = [];
    let runner!: PromotionFlowRunner<TestChannel>;
    let sleepCalls = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => channels,
      getChannel: async (channelId) => channels.find((channel) => channel.channelId === channelId) || null,
      getIntelligenceDocs: async () => channels.map((channel) => collection.docs.get(channel.channelId)!),
      getIntelligenceDoc: async (channelId) => collection.docs.get(channelId)!,
      sendPromotion: async ({ channel, candidate }) => {
        sentChannels.push(channel.channelId);
        return { sent: true, messageId: sentChannels.length, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls === 1) runner.stop();
      },
    };

    runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 2,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.start();

    expect(sentChannels).toHaveLength(1);
    expect(['ch4g-a', 'ch4g-b']).toContain(sentChannels[0]);
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('continues a started runner after a transient promotion cycle failure', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch-start-retry', createDefaultIntelligence('ch-start-retry'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch-start-retry',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const warnings: string[] = [];
    let active = true;
    let loadCalls = 0;
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => active,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => {
        loadCalls++;
        if (loadCalls === 1) throw new Error('mongo transient');
        return [channel];
      },
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch-start-retry')!],
      getIntelligenceDoc: async () => collection.docs.get('ch-start-retry')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        active = false;
        return { sent: true, messageId: 1002, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.start();

    expect(loadCalls).toBe(2);
    expect(sendAttempts).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion channel load failed; skipping cycle'),
    ]));
    expect(runner.getHealth()).toEqual(expect.objectContaining({
      totalCycleFailures: 1,
      consecutiveCycleFailures: 0,
    }));
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('keeps consecutive cycle failures visible for repeated soft runOnce failures', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    let activeCalls = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => {
        activeCalls++;
        return activeCalls <= 2;
      },
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => { throw new Error('channel store unavailable'); },
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 1102, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.start();

    expect(runner.getHealth()).toEqual(expect.objectContaining({
      totalCycleFailures: 2,
      consecutiveCycleFailures: 2,
    }));
    runner.stop();
  });

  it('keeps a started runner alive after transient active-state failures', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('active-retry', createDefaultIntelligence('active-retry'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'active-retry',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const errors: string[] = [];
    let active = true;
    let activeCalls = 0;
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => {
        activeCalls++;
        if (activeCalls === 1) throw new Error('telegram connection transient');
        return active;
      },
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('active-retry')!],
      getIntelligenceDoc: async () => collection.docs.get('active-retry')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        active = false;
        return { sent: true, messageId: 1003, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => {
        if (level === 'error') errors.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.start();

    expect(activeCalls).toBeGreaterThanOrEqual(3);
    expect(sendAttempts).toBe(1);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion active-state check failed; keeping runner alive'),
    ]));
    expect(runner.getHealth()).toEqual(expect.objectContaining({
      status: 'stopped',
      totalCycleFailures: 1,
      totalSuccessfulSends: 1,
      queueSize: 1,
    }));
  });

  it('supervises runner restarts with backoff when a runner exits', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('supervised', createDefaultIntelligence('supervised'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'supervised',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sleeps: number[] = [];
    let created = 0;
    let sent = 0;
    const supervisor = new PromotionRunnerSupervisor<TestChannel>({
      createRunner: () => {
        created++;
        let active = true;
        const adapter: PromotionFlowAdapter<TestChannel> = {
          isActive: () => active,
          getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
          loadChannels: async () => [channel],
          getChannel: async () => channel,
          getIntelligenceDocs: async () => [collection.docs.get('supervised')!],
          getIntelligenceDoc: async () => collection.docs.get('supervised')!,
          sendPromotion: async ({ candidate }) => {
            sent++;
            active = false;
            return { sent: true, messageId: 2000 + sent, messageIndex: candidate.randomIndex };
          },
          checkMessage: async () => ({ status: 'exists' }),
          sleep: async () => {},
        };
        return new PromotionFlowRunner(adapter, {
          account,
          scoringEnabled: false,
          messageBanditEnabled: false,
          redisLockEnabled: false,
          attributionEnabled: false,
          batchTarget: 1,
          messageCheckDelayMs: 0,
          channelLoopDelayMs: 0,
        });
      },
      minRestartDelayMs: 25,
      maxRestartDelayMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
        supervisor.stop();
      },
    });

    await supervisor.start();

    expect(created).toBe(1);
    expect(sent).toBe(1);
    expect(sleeps).toEqual([25]);
    expect(supervisor.getHealth()).toEqual(expect.objectContaining({
      status: 'stopped',
      restartCount: 1,
    }));
  });

  it('does not count an intentional inactive runner exit as a restart', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    let active = true;
    let created = 0;
    const restarts: number[] = [];
    const sleeps: number[] = [];
    const supervisor = new PromotionRunnerSupervisor<TestChannel>({
      createRunner: () => {
        created++;
        const adapter: PromotionFlowAdapter<TestChannel> = {
          isActive: () => {
            active = false;
            return false;
          },
          getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
          loadChannels: async () => [],
          getChannel: async () => null,
          getIntelligenceDocs: async () => [],
          getIntelligenceDoc: async () => null,
          sendPromotion: async ({ candidate }) => ({ sent: false, messageIndex: candidate.randomIndex, terminal: true }),
          checkMessage: async () => ({ status: 'unknown' }),
          sleep: async () => {},
        };
        return new PromotionFlowRunner(adapter, {
          account,
          scoringEnabled: false,
          messageBanditEnabled: false,
          redisLockEnabled: false,
          attributionEnabled: false,
          batchTarget: 1,
          messageCheckDelayMs: 0,
          channelLoopDelayMs: 0,
        });
      },
      shouldRun: () => active,
      onRestart: (health) => { restarts.push(health.restartCount); },
      inactiveDelayMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
        supervisor.stop();
      },
    });

    await supervisor.start();

    expect(created).toBe(1);
    expect(restarts).toEqual([]);
    expect(sleeps).toEqual([25]);
    expect(supervisor.getHealth()).toEqual(expect.objectContaining({
      status: 'stopped',
      restartCount: 0,
    }));
  });

  it('wakes supervisor sleep immediately when stopped during restart backoff', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    let sleepStarted = false;
    let sleepResolved = false;
    let created = 0;
    const supervisor = new PromotionRunnerSupervisor<TestChannel>({
      createRunner: () => {
        created++;
        const adapter: PromotionFlowAdapter<TestChannel> = {
          isActive: () => false,
          getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
          loadChannels: async () => [],
          getChannel: async () => null,
          getIntelligenceDocs: async () => [],
          getIntelligenceDoc: async () => null,
          sendPromotion: async ({ candidate }) => ({ sent: false, messageIndex: candidate.randomIndex, terminal: true }),
          checkMessage: async () => ({ status: 'unknown' }),
          sleep: async () => {},
        };
        return new PromotionFlowRunner(adapter, {
          account,
          scoringEnabled: false,
          messageBanditEnabled: false,
          redisLockEnabled: false,
          attributionEnabled: false,
          batchTarget: 1,
          messageCheckDelayMs: 0,
          channelLoopDelayMs: 0,
        });
      },
      minRestartDelayMs: 60_000,
      maxRestartDelayMs: 60_000,
      sleep: async () => {
        sleepStarted = true;
        supervisor.stop();
        await new Promise<void>(() => undefined);
        sleepResolved = true;
      },
    });

    await supervisor.start();

    expect(created).toBe(1);
    expect(sleepStarted).toBe(true);
    expect(sleepResolved).toBe(false);
    expect(supervisor.getHealth()).toEqual(expect.objectContaining({
      status: 'stopped',
      restartCount: 1,
    }));
  });

  it('falls back to the default supervisor timer when a custom sleep backend fails', async () => {
    jest.useFakeTimers();
    const supervisor = new PromotionRunnerSupervisor<TestChannel>({
      createRunner: () => {
        throw new Error('not used');
      },
      sleep: async () => {
        throw new Error('timer backend down');
      },
    });
    let settled = false;

    try {
      const sleepPromise = (supervisor as unknown as { sleep(ms: number): Promise<void> }).sleep(1000)
        .then(() => { settled = true; });
      await Promise.resolve();

      expect(supervisor.getHealth().lastError).toContain('supervisor sleep failed: timer backend down');
      await jest.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await sleepPromise;
      expect(settled).toBe(true);
    } finally {
      supervisor.stop();
      jest.useRealTimers();
    }
  });

  it('keeps supervisor failure state when a watchdog-stopped runner exits normally', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    let supervisor: PromotionRunnerSupervisor<TestChannel>;
    const runner = new PromotionFlowRunner<TestChannel>({
      isActive: () => false,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: false, messageIndex: candidate.randomIndex, terminal: true }),
      checkMessage: async () => ({ status: 'unknown' }),
      sleep: async () => {},
    }, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    runner.start = async () => {
      (supervisor as unknown as { currentRunnerStoppedAsStuck: boolean }).currentRunnerStoppedAsStuck = true;
      (supervisor as unknown as { recordError: (error: string) => void }).recordError('runner stuck for 1000ms');
    };

    supervisor = new PromotionRunnerSupervisor<TestChannel>({
      createRunner: () => runner,
      minRestartDelayMs: 1,
      maxRestartDelayMs: 1,
      sleep: async () => {
        supervisor.stop();
      },
    });

    await supervisor.start();

    expect(supervisor.getHealth()).toEqual(expect.objectContaining({
      status: 'stopped',
      restartCount: 1,
      consecutiveRunnerFailures: 1,
      lastError: 'runner stuck for 1000ms',
    }));
  });

  it('bounds the supervisor watchdog interval when explicitly configured as zero', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const runner = new PromotionFlowRunner<TestChannel>({
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: false, messageIndex: candidate.randomIndex, terminal: true }),
      checkMessage: async () => ({ status: 'unknown' }),
      sleep: async () => {},
    }, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });
    const supervisor = new PromotionRunnerSupervisor<TestChannel>({
      createRunner: () => runner,
      stuckAfterMs: 10_000,
      healthCheckIntervalMs: 0,
    });
    let checks = 0;
    (supervisor as unknown as { currentRunner: PromotionFlowRunner<TestChannel> }).currentRunner = runner;
    (runner as unknown as { running: boolean }).running = true;
    (runner as unknown as { status: string }).status = 'running';
    (runner as unknown as { health: { startedAt: number } }).health.startedAt = Date.now();
    (supervisor as unknown as { checkRunnerHealth: () => Promise<void> }).checkRunnerHealth = async () => {
      checks++;
    };

    try {
      (supervisor as unknown as { startWatchdog: () => void }).startWatchdog();
      await jest.advanceTimersByTimeAsync(999);
      expect(checks).toBe(0);

      await jest.advanceTimersByTimeAsync(1);
      expect(checks).toBe(1);
    } finally {
      supervisor.stop();
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('clears scheduled follow-ups when a started runner exits naturally', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch4h', createDefaultIntelligence('ch4h'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch4h',
      participantsCount: 1000,
      canSendMsgs: true,
      wordRestriction: 1,
      dMRestriction: 0,
      availableMsgs: ['0'],
    };
    const sent: Array<{ kind: string; isFollowUp: boolean }> = [];
    const scheduledFollowUps: string[] = [];
    let isActiveCalls = 0;
    let loadChannelsCalls = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => {
        isActiveCalls++;
        return isActiveCalls <= 3;
      },
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => {
        loadChannelsCalls++;
        return loadChannelsCalls === 1 ? [channel] : [];
      },
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch4h')!],
      getIntelligenceDoc: async () => collection.docs.get('ch4h')!,
      sendPromotion: async ({ candidate, isFollowUp }) => {
        sent.push({ kind: candidate.kind, isFollowUp });
        return { sent: true, messageId: isFollowUp ? 405 : 404, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      onFollowUpScheduled: (message) => { scheduledFollowUps.push(message.channelId); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      followUpDelayMs: 60_000,
      followUpJitterMs: 0,
      channelLoopDelayMs: 0,
    });

    try {
      await runner.start();
      expect(sent).toEqual([{ kind: 'legacy', isFollowUp: false }]);
      expect(scheduledFollowUps).toEqual(['ch4h']);

      await jest.advanceTimersByTimeAsync(60_000);
      expect(sent).toEqual([{ kind: 'legacy', isFollowUp: false }]);
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('checks queued messages on the runner interval while channel processing is sleeping', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch5', createDefaultIntelligence('ch5'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch5',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const existingMessages: string[] = [];
    let active = true;
    let sleepResolve: () => void = () => undefined;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => active,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch5')!],
      getIntelligenceDoc: async () => collection.docs.get('ch5')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 505, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      onMessageExisting: (message) => { existingMessages.push(message.channelId); },
      sleep: async () => {
        if (!active) return;
        await new Promise<void>((resolve) => { sleepResolve = resolve; });
      },
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      messageCheckIntervalMs: 1000,
      channelLoopDelayMs: 60_000,
    });

    const startPromise = runner.start();
    try {
      for (let i = 0; i < 10 && runner.getQueueSize() === 0; i++) {
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(runner.getQueueSize()).toBe(1);

      await jest.advanceTimersByTimeAsync(1000);

      expect(existingMessages).toEqual(['ch5']);
      expect(runner.getQueueSize()).toBe(0);
    } finally {
      active = false;
      runner.stop();
      sleepResolve();
      await startPromise;
      jest.useRealTimers();
    }
  });

  it('normalizes unexpected queue interval errors before logging', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const logs: string[] = [];
    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: false, messageIndex: candidate.randomIndex, terminal: true }),
      checkMessage: async () => ({ status: 'unknown' }),
      log: (_level, message) => { logs.push(message); },
      sleep: async () => {},
    };
    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      messageCheckIntervalMs: 1000,
      channelLoopDelayMs: 0,
    });

    try {
      (runner as unknown as { checkQueuedMessages: () => Promise<void> }).checkQueuedMessages = async () => {
        throw { code: 'QUEUE_FAIL' };
      };
      (runner as unknown as { running: boolean }).running = true;
      (runner as unknown as { startQueueChecker: () => void }).startQueueChecker();

      await jest.advanceTimersByTimeAsync(1000);

      expect(logs).toContain('Promotion queue check failed: {"code":"QUEUE_FAIL"}');
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('keeps the background queue checker interval bounded when message checks are immediately eligible', async () => {
    jest.useFakeTimers();
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const logs: string[] = [];
    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: false, messageIndex: candidate.randomIndex, terminal: true }),
      checkMessage: async () => ({ status: 'unknown' }),
      log: (_level, message) => { logs.push(message); },
      sleep: async () => {},
    };
    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      messageCheckIntervalMs: 0,
      channelLoopDelayMs: 0,
    });

    try {
      (runner as unknown as { checkQueuedMessages: () => Promise<void> }).checkQueuedMessages = async () => {
        throw new Error('queue tick');
      };
      (runner as unknown as { running: boolean }).running = true;
      (runner as unknown as { startQueueChecker: () => void }).startQueueChecker();

      await jest.advanceTimersByTimeAsync(999);
      expect(logs).toEqual([]);

      await jest.advanceTimersByTimeAsync(1);
      expect(logs).toContain('Promotion queue check failed: queue tick');
    } finally {
      runner.stop();
      jest.useRealTimers();
    }
  });

  it('can reuse an externally owned message queue across runner instances', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch6', createDefaultIntelligence('ch6'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'ch6',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const messageQueue = new PromotionMessageQueue(10);
    const existingMessages: string[] = [];

    const createAdapter = (): PromotionFlowAdapter<TestChannel> => ({
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('ch6')!],
      getIntelligenceDoc: async () => collection.docs.get('ch6')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 606, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      onMessageExisting: (message) => { existingMessages.push(message.channelId); },
      sleep: async () => {},
    });
    const createRunner = () => new PromotionFlowRunner(createAdapter(), {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      messageQueue,
    });

    const firstRunner = createRunner();
    await firstRunner.runOnce();
    expect(firstRunner.getQueueSize()).toBe(1);
    firstRunner.stop();

    const secondRunner = createRunner();
    expect(secondRunner.getQueueSize()).toBe(1);
    await secondRunner.checkQueuedMessages();
    expect(existingMessages).toEqual(['ch6']);
    expect(secondRunner.getQueueSize()).toBe(0);
    secondRunner.stop();
  });

  it('bounds and clears externally managed promotion queues', () => {
    const messageQueue = new PromotionMessageQueue(2);
    const first = {
      channelId: 'oldest',
      messageId: 1,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    };
    const second = {
      channelId: 'middle',
      messageId: 2,
      messageIndex: '0',
      timestamp: 10,
      isFollowUp: false,
      availableMessageCount: 1,
    };
    const third = {
      channelId: 'newest',
      messageId: 3,
      messageIndex: '0',
      timestamp: 20,
      isFollowUp: false,
      availableMessageCount: 1,
    };

    messageQueue.enqueue(first);
    messageQueue.enqueue(second);
    messageQueue.enqueue(third);

    expect(messageQueue.size).toBe(2);
    expect(messageQueue.isQueued('oldest')).toBe(false);
    expect(messageQueue.readyForCheck(30, 10).map((message) => message.channelId)).toEqual(['middle', 'newest']);
    messageQueue.remove(first);
    expect(messageQueue.size).toBe(2);
    messageQueue.clear();
    expect(messageQueue.size).toBe(0);
  });

  it('normalizes queue capacity and treats malformed timestamps as ready for retry', () => {
    const invalidCapacityQueue = new PromotionMessageQueue(Number.NaN);
    invalidCapacityQueue.enqueue({
      channelId: 'kept',
      messageId: 1,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    expect(invalidCapacityQueue.size).toBe(1);

    const boundedQueue = new PromotionMessageQueue(1.8);
    boundedQueue.enqueue({
      channelId: 'dropped',
      messageId: 1,
      messageIndex: '0',
      timestamp: 10,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    boundedQueue.enqueue({
      channelId: 'kept-float-bound',
      messageId: 2,
      messageIndex: '0',
      timestamp: Number.NaN,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    boundedQueue.enqueue({
      channelId: 'future',
      messageId: 3,
      messageIndex: '0',
      timestamp: 10_000,
      isFollowUp: false,
      availableMessageCount: 1,
    });

    expect(boundedQueue.size).toBe(1);
    expect(boundedQueue.isQueued('dropped')).toBe(false);
    expect(boundedQueue.readyForCheck(100, 50).map((message) => message.channelId)).toEqual(['future']);
  });

  it('normalizes externally queued messages and rejects invalid queue entries', () => {
    const messageQueue = new PromotionMessageQueue(10);

    expect(() => messageQueue.enqueue(null as unknown as any)).not.toThrow();
    messageQueue.enqueue({
      channelId: '  queued-channel  ',
      messageId: 123,
      messageIndex: null as unknown as string,
      timestamp: Number.NaN,
      isFollowUp: false,
      availableMessageCount: Number.NaN,
      strategy: ' bad_strategy ' as any,
      unexpected: 'drop-me',
    } as unknown as Parameters<PromotionMessageQueue['enqueue']>[0]);
    messageQueue.enqueue({
      channelId: '  -100777  ',
      messageId: 125,
      messageIndex: 'custom',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
      strategy: ' question_doubt ' as any,
    });
    messageQueue.enqueue({
      channelId: '   ',
      messageId: 124,
      messageIndex: '0',
      timestamp: 10,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    messageQueue.enqueue({
      channelId: 'bad-message-id',
      messageId: 0,
      messageIndex: '0',
      timestamp: 10,
      isFollowUp: false,
      availableMessageCount: 1,
    });

    expect(messageQueue.size).toBe(2);
    expect(messageQueue.isQueued('queued-channel')).toBe(true);
    expect(messageQueue.isQueued('  queued-channel  ')).toBe(true);
    expect(messageQueue.isQueued('-777')).toBe(true);
    expect(messageQueue.isQueued('777')).toBe(true);
    expect(messageQueue.readyForCheck(100, 50)).toEqual([
      expect.objectContaining({
        channelId: 'queued-channel',
        messageIndex: '0',
        timestamp: 0,
      }),
      expect.objectContaining({
        channelId: '777',
        messageIndex: 'custom',
      }),
    ]);
    expect(messageQueue.readyForCheck(100, 50)[0]).not.toHaveProperty('strategy');
    expect(messageQueue.readyForCheck(100, 50)[1]).not.toHaveProperty('strategy');
    expect(messageQueue.readyForCheck(100, 50)[0]).not.toHaveProperty('availableMessageCount');
    expect(messageQueue.readyForCheck(100, 50)[0]).not.toHaveProperty('unexpected');
  });

  it('normalizes direct processChannel calls before all accounting and queue ownership', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('777', createDefaultIntelligence('777'));
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    const sentChannels: string[] = [];
    const accountSuccess = jest.spyOn(account, 'recordSuccess');
    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async (channelId) => collection.docs.get(channelId) ?? null,
      sendPromotion: async ({ channel, candidate }) => {
        sentChannels.push(channel.channelId);
        return { sent: true, messageId: 7771, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      messageQueue,
    });

    await runner.processChannel({
      channelId: '-100777',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    }, false);

    expect(sentChannels).toEqual(['777']);
    expect(accountSuccess).toHaveBeenCalledWith('777', expect.any(String), false);
    expect(messageQueue.isQueued('-100777')).toBe(true);
    expect(messageQueue.readyForCheck(Date.now() + 1, 0)[0]?.channelId).toBe('777');
    expect(collection.docs.has('-100777')).toBe(false);
    runner.stop();
  });

  it('does not apply queued message side effects after a started runner is stopped mid-check', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'stop-mid-check',
      messageId: 901,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    let deletedCallbacks = 0;
    let deletionRecords = 0;

    const runner = new PromotionFlowRunner<TestChannel>({
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: false, messageIndex: candidate.randomIndex, terminal: true }),
      checkMessage: async () => {
        runner.stop();
        return { status: 'deleted' };
      },
      onMessageDeleted: () => { deletedCallbacks++; },
      sleep: async () => {},
    }, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      messageQueue,
    });
    const originalRecordDeletion = account.recordDeletion.bind(account);
    (account as unknown as { recordDeletion: typeof account.recordDeletion }).recordDeletion = async (...args) => {
      deletionRecords++;
      return originalRecordDeletion(...args);
    };
    (runner as unknown as { startedByStart: boolean; running: boolean }).startedByStart = true;
    (runner as unknown as { startedByStart: boolean; running: boolean }).running = true;

    await runner.checkQueuedMessages();

    expect(deletedCallbacks).toBe(0);
    expect(deletionRecords).toBe(0);
    expect(messageQueue.size).toBe(1);
  });

  it('does not apply send side effects after a started runner is stopped mid-send', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('stop-mid-send', createDefaultIntelligence('stop-mid-send'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'stop-mid-send',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    let successCallbacks = 0;
    let successRecords = 0;
    let sendAttempts = 0;

    let runner!: PromotionFlowRunner<TestChannel>;
    runner = new PromotionFlowRunner<TestChannel>({
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('stop-mid-send')!],
      getIntelligenceDoc: async () => collection.docs.get('stop-mid-send')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        runner.stop();
        return { sent: true, messageId: 902, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'unknown' }),
      onSendSuccess: () => { successCallbacks++; },
      sleep: async () => {},
    }, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });
    const originalRecordSuccess = account.recordSuccess.bind(account);
    (account as unknown as { recordSuccess: typeof account.recordSuccess }).recordSuccess = async (...args) => {
      successRecords++;
      return originalRecordSuccess(...args);
    };
    (runner as unknown as { startedByStart: boolean; running: boolean }).startedByStart = true;
    (runner as unknown as { startedByStart: boolean; running: boolean }).running = true;

    await runner.processChannel(channel, false);

    expect(sendAttempts).toBe(1);
    expect(successCallbacks).toBe(0);
    expect(successRecords).toBe(0);
    expect(runner.getQueueSize()).toBe(0);
  });

  it('does not execute follow-up work after a started runner has stopped', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    let activeChecks = 0;
    let channelLookups = 0;
    let sendAttempts = 0;

    const runner = new PromotionFlowRunner<TestChannel>({
      isActive: () => {
        activeChecks++;
        return true;
      },
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => {
        channelLookups++;
        return {
          channelId: 'stopped-follow-up',
          participantsCount: 1000,
          canSendMsgs: true,
          availableMsgs: ['0'],
        };
      },
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 903, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'unknown' }),
      sleep: async () => {},
    }, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });
    (runner as unknown as { startedByStart: boolean; running: boolean }).startedByStart = true;
    (runner as unknown as { startedByStart: boolean; running: boolean }).running = false;

    await (runner as unknown as { runFollowUp(message: PromotionQueuedMessage): Promise<void> }).runFollowUp({
      channelId: 'stopped-follow-up',
      messageId: 902,
      messageIndex: '0',
      timestamp: Date.now(),
      isFollowUp: false,
      availableMessageCount: 1,
    });

    expect(activeChecks).toBe(0);
    expect(channelLookups).toBe(0);
    expect(sendAttempts).toBe(0);
    expect(runner.getHealth().lastFollowUpFinishedAt).not.toBeNull();
  });

  it('normalizes malformed runner timing and batch options before executing flow', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('timing-channel', createDefaultIntelligence('timing-channel'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'timing-channel',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'queued-recent',
      messageId: 1,
      messageIndex: '0',
      timestamp: Date.now(),
      isFollowUp: false,
      availableMessageCount: 1,
    });
    let sendAttempts = 0;
    let checkAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('timing-channel')!],
      getIntelligenceDoc: async () => collection.docs.get('timing-channel')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 909, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => {
        checkAttempts++;
        return { status: 'exists' };
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: Number.NaN,
      messageCheckDelayMs: Number.NaN,
      channelLoopDelayMs: Number.NaN,
      messageQueue,
    });

    await runner.runOnce();

    expect(checkAttempts).toBe(0);
    expect(sendAttempts).toBe(0);
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('falls back to safe runner delays when optional timing config is malformed', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('sleep-channel', createDefaultIntelligence('sleep-channel'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'sleep-channel',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sleeps: number[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('sleep-channel')!],
      getIntelligenceDoc: async () => collection.docs.get('sleep-channel')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 910, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async (ms) => { sleeps.push(ms); },
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1.9,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: Number.POSITIVE_INFINITY,
    });

    await runner.runOnce();

    expect(sleeps).toEqual([5000]);
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('uses the policy batch limit when batchTarget is omitted by JavaScript consumers', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('default-batch-channel', createDefaultIntelligence('default-batch-channel'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'default-batch-channel',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('default-batch-channel')!],
      getIntelligenceDoc: async () => collection.docs.get('default-batch-channel')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 911, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
    });

    await runner.runOnce();

    expect(sendAttempts).toBe(1);
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('isolates adapter sleep failures from direct promotion cycles', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('sleep-failure-channel', createDefaultIntelligence('sleep-failure-channel'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'sleep-failure-channel',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const warnings: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('sleep-failure-channel')!],
      getIntelligenceDoc: async () => collection.docs.get('sleep-failure-channel')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 910, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => { throw new Error('timer backend down'); },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      channelLoopDelayMs: 1,
    });

    await expect(runner.runOnce()).resolves.toBeUndefined();

    expect(runner.getQueueSize()).toBe(1);
    expect(warnings.some((message) => message.includes('Promotion sleep failed'))).toBe(true);
    runner.stop();
  });

  it('completes existing-message queue checks when follow-up stats fail', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'stats-fail-follow-up',
      messageId: 911,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    const warnings: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => { throw new Error('stats unavailable'); },
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 911, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      messageQueue,
    });

    await expect(runner.checkQueuedMessages()).resolves.toBeUndefined();

    expect(runner.getQueueSize()).toBe(0);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Follow-up stats load failed; not scheduling follow-up'),
    ]));
    runner.stop();
  });

  it('normalizes malformed queued message survival before deletion accounting', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('future-delete', createDefaultIntelligence('future-delete'));
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'future-delete',
      messageId: 912,
      messageIndex: '0',
      timestamp: Date.now() + 60_000,
      isFollowUp: false,
      availableMessageCount: 1,
    });
    const survivals: number[] = [];
    const originalRecordDeletion = account.recordDeletion.bind(account);
    (account as any).recordDeletion = async (
      channelId: string,
      strategy: any,
      survivalMs: number,
      isFollowUp: boolean,
    ) => {
      survivals.push(survivalMs);
      await originalRecordDeletion(channelId, strategy, survivalMs, isFollowUp);
    };

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => collection.docs.get('future-delete')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 912, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'deleted' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      messageQueue,
    });

    await runner.checkQueuedMessages();

    expect(survivals).toEqual([0]);
    expect(runner.getQueueSize()).toBe(0);
    runner.stop();
  });

  it('treats malformed adapter stats as safe zero counters before policy decisions', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('stats-malformed', createDefaultIntelligence('stats-malformed'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'stats-malformed',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => null as any,
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('stats-malformed')!],
      getIntelligenceDoc: async () => collection.docs.get('stats-malformed')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 913, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sendAttempts).toBe(1);
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('skips a direct runOnce cycle when channel loading throws', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const warnings: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => { throw new Error('channel store unavailable'); },
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 914, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      channelLoopDelayMs: 0,
    });

    await expect(runner.runOnce()).resolves.toBeUndefined();

    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion channel load failed; skipping cycle'),
    ]));
    expect(runner.getHealth()).toEqual(expect.objectContaining({
      totalCycleFailures: 1,
      consecutiveCycleFailures: 1,
    }));
    runner.stop();
  });

  it('normalizes loaded channel ids and skips malformed channel rows at the runner boundary', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('trimmed-channel', createDefaultIntelligence('trimmed-channel'));
    const account = await createAccount(collection);
    const loadedChannelRows = [
      { channelId: ' trimmed-channel ', participantsCount: 1000, canSendMsgs: true, availableMsgs: ['0'] },
      { channelId: '   ', participantsCount: 1000, canSendMsgs: true, availableMsgs: ['0'] },
      null,
    ] as unknown as TestChannel[];
    const docLookups: string[][] = [];
    const sentChannels: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => loadedChannelRows,
      getChannel: async () => null,
      getIntelligenceDocs: async (channelIds) => {
        docLookups.push(channelIds);
        return [collection.docs.get('trimmed-channel')!];
      },
      getIntelligenceDoc: async (channelId) => collection.docs.get(channelId)!,
      sendPromotion: async ({ channel, candidate }) => {
        sentChannels.push(channel.channelId);
        return { sent: true, messageId: 1202, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'unknown' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 3,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(docLookups).toEqual([['trimmed-channel']]);
    expect(sentChannels).toEqual(['trimmed-channel']);
    expect(collection.docs.get('trimmed-channel')!.totalSendsToChannel).toBe(1);
    runner.stop();
  });

  it('skips malformed direct processChannel calls without throwing', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const warnings: string[] = [];
    let sendAttempts = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 1203, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'unknown' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
    });

    await expect(runner.processChannel({ channelId: '   ' } as TestChannel, false)).resolves.toBeUndefined();

    expect(sendAttempts).toBe(0);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion channel attempt skipped; malformed channel='),
    ]));
    runner.stop();
  });

  it('retains queued messages when adapter returns malformed check results', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    messageQueue.enqueue({
      channelId: 'malformed-check',
      messageId: 914,
      messageIndex: '0',
      timestamp: 0,
      isFollowUp: false,
      availableMessageCount: 1,
    });

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [],
      getChannel: async () => null,
      getIntelligenceDocs: async () => [],
      getIntelligenceDoc: async () => null,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 914, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'bad' }) as any,
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      messageQueue,
    });

    await runner.checkQueuedMessages();

    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('continues send planning with safe zero counters when stats loading fails', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('stats-throws', createDefaultIntelligence('stats-throws'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'stats-throws',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    let sendAttempts = 0;
    const warnings: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => { throw new Error('stats backend down'); },
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('stats-throws')!],
      getIntelligenceDoc: async () => collection.docs.get('stats-throws')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 916, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => { if (level === 'warn') warnings.push(message); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sendAttempts).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion stats load failed during planning'),
      expect.stringContaining('Promotion stats load failed during message planning'),
    ]));
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('continues selection as cold start when intelligence batch loading fails', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('intel-batch-throws', createDefaultIntelligence('intel-batch-throws'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'intel-batch-throws',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    let sendAttempts = 0;
    const warnings: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => { throw new Error('intelligence unavailable'); },
      getIntelligenceDoc: async () => collection.docs.get('intel-batch-throws')!,
      sendPromotion: async ({ candidate }) => {
        sendAttempts++;
        return { sent: true, messageId: 917, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      log: (level, message) => { if (level === 'warn') warnings.push(message); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(sendAttempts).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Promotion intelligence docs batch load failed'),
    ]));
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });

  it('treats malformed adapter send results as terminal failures', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('bad-send-result', createDefaultIntelligence('bad-send-result'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'bad-send-result',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
      wordRestriction: 1,
    };
    const failures: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('bad-send-result')!],
      getIntelligenceDoc: async () => collection.docs.get('bad-send-result')!,
      sendPromotion: async () => null as any,
      checkMessage: async () => ({ status: 'exists' }),
      onSendFailure: (_channel, errorMessage) => { failures.push(errorMessage); },
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
    });

    await runner.runOnce();

    expect(failures).toEqual(['Malformed promotion send result']);
    expect(runner.getQueueSize()).toBe(0);
    const doc = collection.docs.get('bad-send-result')!;
    expect(doc.strategies.legacy.f).toBe(1);
    expect((doc.strategies as Record<string, unknown>)['undefined']).toBeUndefined();
    runner.stop();
  });

  it('normalizes malformed available message lists before candidate planning and queue counts', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('bad-available-msgs', createDefaultIntelligence('bad-available-msgs'));
    const account = await createAccount(collection);
    const messageQueue = new PromotionMessageQueue();
    const channel = {
      channelId: 'bad-available-msgs',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: '7',
      wordRestriction: 1,
    } as unknown as TestChannel;
    const sentIndexes: string[] = [];

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => ({ successCount: 0, failedCount: 0, failStreak: 0, daysLeft: 1 }),
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('bad-available-msgs')!],
      getIntelligenceDoc: async () => collection.docs.get('bad-available-msgs')!,
      sendPromotion: async ({ candidate }) => {
        sentIndexes.push(candidate.randomIndex);
        return { sent: true, messageId: 919, messageIndex: candidate.randomIndex };
      },
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async () => {},
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: false,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 0,
      messageQueue,
    });

    await runner.runOnce();

    expect(sentIndexes).toEqual(['0']);
    expect(messageQueue.readyForCheck(Date.now() + 1, 0)).toEqual([
      expect.objectContaining({
        channelId: 'bad-available-msgs',
        messageId: 919,
      }),
    ]);
    expect(messageQueue.readyForCheck(Date.now() + 1, 0)[0]).not.toHaveProperty('availableMessageCount');
    runner.stop();
  });

  it('uses configured delay fallback when scoring delay stats fail after a send', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('delay-stats-fail', createDefaultIntelligence('delay-stats-fail'));
    const account = await createAccount(collection);
    const channel: TestChannel = {
      channelId: 'delay-stats-fail',
      participantsCount: 1000,
      canSendMsgs: true,
      availableMsgs: ['0'],
    };
    const sleeps: number[] = [];
    let statsCalls = 0;

    const adapter: PromotionFlowAdapter<TestChannel> = {
      isActive: () => true,
      getStats: () => {
        statsCalls++;
        if (statsCalls === 3) throw new Error('stats unavailable after send');
        return { successCount: 1, failedCount: 0, failStreak: 0, daysLeft: 1 };
      },
      loadChannels: async () => [channel],
      getChannel: async () => channel,
      getIntelligenceDocs: async () => [collection.docs.get('delay-stats-fail')!],
      getIntelligenceDoc: async () => collection.docs.get('delay-stats-fail')!,
      sendPromotion: async ({ candidate }) => ({ sent: true, messageId: 915, messageIndex: candidate.randomIndex }),
      checkMessage: async () => ({ status: 'exists' }),
      sleep: async (ms) => { sleeps.push(ms); },
    };

    const runner = new PromotionFlowRunner(adapter, {
      account,
      scoringEnabled: true,
      messageBanditEnabled: false,
      redisLockEnabled: false,
      attributionEnabled: false,
      batchTarget: 1,
      messageCheckDelayMs: 0,
      channelLoopDelayMs: 1234,
    });

    await runner.runOnce();

    expect(sleeps).toEqual([1234]);
    expect(runner.getQueueSize()).toBe(1);
    runner.stop();
  });
});

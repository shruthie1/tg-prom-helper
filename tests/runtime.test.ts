import {
  ChannelIntelligenceService,
  PercentileEngine,
  createDefaultIntelligence,
  type ChannelIntelligenceDocument,
} from '../src';
import { ConversionAttributionService } from '../src';
import { RedisChannelLock, RedisPromotionTracker } from '../src';
import { createPromotionRuntime, PromotionRuntime } from '../src';

class Cursor<T> {
  constructor(private rows: T[]) {}
  sort(): Cursor<T> { return this; }
  limit(limit: number): Cursor<T> {
    this.rows = this.rows.slice(0, limit);
    return this;
  }
  async toArray(): Promise<T[]> { return this.rows; }
}

class CollectionMock<T extends { channelId: string }> {
  docs = new Map<string, T>();

  async findOne(filter: { channelId: string }): Promise<T | null> {
    return this.docs.get(filter.channelId) || null;
  }

  find(): Cursor<T> {
    return new Cursor(Array.from(this.docs.values()));
  }

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

  aggregate(): Cursor<Record<string, unknown>> {
    return new Cursor([{ successRateValues: [], deleteRateValues: [] }]);
  }

  private applyUpdate(doc: any, update: any): void {
    for (const [path, value] of Object.entries(update.$inc || {})) {
      this.setPath(doc, path, (this.getPath(doc, path) || 0) + Number(value));
    }
    for (const [path, value] of Object.entries(update.$set || {})) {
      this.setPath(doc, path, value);
    }
  }

  private getPath(obj: any, path: string): any {
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
  }

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

class RedisMock {
  values = new Map<string, string>();
  lists = new Map<string, string[]>();

  pipeline() {
    const ops: Array<() => void> = [];
    return {
      lpush: (key: string, value: string) => { ops.push(() => this.lists.set(key, [value, ...(this.lists.get(key) || [])])); return this.pipelineResult(ops); },
      ltrim: (key: string, start: number, stop: number) => { ops.push(() => this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1))); return this.pipelineResult(ops); },
      expire: () => this.pipelineResult(ops),
      set: (key: string, value: string) => { ops.push(() => this.values.set(key, value)); return this.pipelineResult(ops); },
      exec: async () => { ops.forEach(op => op()); },
    };
  }

  private pipelineResult(ops: Array<() => void>): any {
    return {
      lpush: (key: string, value: string) => { ops.push(() => this.lists.set(key, [value, ...(this.lists.get(key) || [])])); return this.pipelineResult(ops); },
      ltrim: (key: string, start: number, stop: number) => { ops.push(() => this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1))); return this.pipelineResult(ops); },
      expire: () => this.pipelineResult(ops),
      set: (key: string, value: string) => { ops.push(() => this.values.set(key, value)); return this.pipelineResult(ops); },
      exec: async () => { ops.forEach(op => op()); },
    };
  }

  async get(key: string): Promise<string | null> { return this.values.get(key) || null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async exists(key: string): Promise<number> { return this.values.has(key) ? 1 : 0; }
  async lrange(key: string): Promise<string[]> { return this.lists.get(key) || []; }
}

describe('PromotionRuntime', () => {
  beforeEach(() => {
    PromotionRuntime.reset();
  });

  it('fails fast when accessed before initialization', () => {
    expect(() => PromotionRuntime.getInstance()).toThrow('PromotionRuntime not initialized');
  });

  it('fails fast with a clear error for malformed runtime options', async () => {
    await expect(createPromotionRuntime(null as unknown as Parameters<typeof createPromotionRuntime>[0]))
      .rejects.toThrow('PromotionRuntime channelIntelligenceCollection is required');

    await expect(createPromotionRuntime({} as Parameters<typeof createPromotionRuntime>[0]))
      .rejects.toThrow('PromotionRuntime channelIntelligenceCollection is required');

    expect(() => PromotionRuntime.getInstance()).toThrow('PromotionRuntime not initialized');
  });

  it('resets runtime and promotion service singletons', async () => {
    const intelligence = new CollectionMock<ChannelIntelligenceDocument>();
    const redis = new RedisMock();
    await createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis,
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    });

    expect(PromotionRuntime.getInstance().channelLock).not.toBeNull();
    PromotionRuntime.reset();

    expect(() => PromotionRuntime.getInstance()).toThrow('PromotionRuntime not initialized');
    expect(() => ChannelIntelligenceService.getInstance()).toThrow('ChannelIntelligenceService not initialized');
    expect(() => PercentileEngine.getInstance()).toThrow('PercentileEngine not initialized');
    expect(() => RedisChannelLock.getInstance()).toThrow('RedisChannelLock not initialized');
    expect(() => RedisPromotionTracker.getInstance()).toThrow('RedisPromotionTracker not initialized');
    expect(() => ConversionAttributionService.getInstance()).toThrow('ConversionAttributionService not initialized');
  });

  it('supports multiple account contexts on one shared runtime', async () => {
    const intelligence = new CollectionMock<ChannelIntelligenceDocument>();
    intelligence.docs.set('ch1', createDefaultIntelligence('ch1'));
    intelligence.docs.set('ch2', createDefaultIntelligence('ch2'));
    const redis = new RedisMock();

    const runtime = await createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis,
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    });

    const accountA = runtime.createAccountContext({ mobile: '919100000001', clientId: 'client-a' });
    const accountB = runtime.createAccountContext({ mobile: '919100000002', clientId: 'client-b' });

    await accountA.recordSend('ch1');
    await accountB.recordSend('ch2');
    await accountA.markPromoted('ch1');

    expect(await accountA.isRecentlyPromoted('ch1')).toBe(true);
    expect(await runtime.tracker?.getLastPromoter('ch1')).toEqual(expect.objectContaining({
      mobile: '919100000001',
      clientId: 'client-a',
    }));
    expect(await runtime.tracker?.getLastPromoter('ch2')).toEqual(expect.objectContaining({
      mobile: '919100000002',
      clientId: 'client-b',
    }));
  });

  it('normalizes Telegram peer-prefixed channel ids at the account runtime boundary', async () => {
    const intelligence = new CollectionMock<ChannelIntelligenceDocument>();
    intelligence.docs.set('12345', createDefaultIntelligence('12345'));
    const redis = new RedisMock();

    const runtime = await createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis,
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    });
    const account = runtime.createAccountContext({ mobile: '919100000001', clientId: 'client-a' });

    await account.recordSend('-10012345');
    await account.markPromoted('-12345');
    await account.recordSuccess('-10012345', 'legacy', false);

    expect(await account.isRecentlyPromoted('12345')).toBe(true);
    expect(await runtime.tracker?.getLastPromoter('12345')).toEqual(expect.objectContaining({
      mobile: '919100000001',
      clientId: 'client-a',
    }));
    expect(intelligence.docs.get('12345')!.strategies.legacy.s).toBe(1);
    expect(intelligence.docs.get('-10012345')).toBeUndefined();
  });

  it('warms percentile cache by default when Redis and active channels are available', async () => {
    const intelligence = new CollectionMock<ChannelIntelligenceDocument>();
    intelligence.docs.set('ch1', createDefaultIntelligence('ch1'));

    const runtime = await createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis: new RedisMock(),
      enablePercentiles: true,
      enableLocks: false,
      enableAttribution: false,
    });

    expect(runtime.percentiles).not.toBeNull();
    expect(runtime.percentiles?.getCachedPercentiles()).not.toBeNull();
  });

  it('keeps optional redis-backed services disabled on first runtime when flags are off', async () => {
    const intelligence = new CollectionMock<ChannelIntelligenceDocument>();
    intelligence.docs.set('ch1', createDefaultIntelligence('ch1'));

    const runtime = await createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis: new RedisMock(),
      enableLocks: false,
      enableAttribution: false,
      enablePercentiles: false,
      warmPercentiles: false,
    });

    expect(runtime.percentiles).toBeNull();
    expect(runtime.channelLock).toBeNull();
    expect(runtime.tracker).toBeNull();
    expect(runtime.attribution).toBeNull();
    expect(await runtime.createAccountContext({ mobile: '919100000001', clientId: 'client-a' }).isRecentlyPromoted('ch1')).toBe(false);
    expect(() => RedisChannelLock.getInstance()).toThrow('RedisChannelLock not initialized');
    expect(() => RedisPromotionTracker.getInstance()).toThrow('RedisPromotionTracker not initialized');
    expect(() => ConversionAttributionService.getInstance()).toThrow('ConversionAttributionService not initialized');
  });

  it('creates lock service with a lock-compatible Redis wrapper when attribution is disabled', async () => {
    const intelligence = new CollectionMock<ChannelIntelligenceDocument>();
    const values = new Map<string, string>();
    const lockOnlyRedis = {
      get: async (key: string) => values.get(key) || null,
      set: async (key: string, value: string) => { values.set(key, value); },
      exists: async (key: string) => (values.has(key) ? 1 : 0),
    };

    const runtime = await createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis: lockOnlyRedis as any,
      enablePercentiles: false,
      enableLocks: true,
      enableAttribution: false,
      warmPercentiles: false,
    });
    const account = runtime.createAccountContext({ mobile: '919100000001', clientId: 'client-a' });

    await account.markPromoted('lock-only-channel');

    expect(runtime.channelLock).not.toBeNull();
    expect(runtime.tracker).toBeNull();
    expect(runtime.attribution).toBeNull();
    expect(await account.isRecentlyPromoted('lock-only-channel')).toBe(true);
  });

  it('fails fast when enabled Redis-backed runtime features receive an incompatible Redis client', async () => {
    const intelligence = new CollectionMock<ChannelIntelligenceDocument>();
    const lockOnlyRedis = {
      get: async () => null,
      set: async () => 'OK',
      exists: async () => 0,
    };
    const trackerOnlyRedis = {
      get: async () => null,
      set: async () => 'OK',
      lrange: async () => [],
      pipeline: () => ({
        lpush: () => undefined,
        ltrim: () => undefined,
        expire: () => undefined,
        set: () => undefined,
        exec: async () => undefined,
      }),
    };

    await expect(createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis: null,
      enableLocks: true,
      enableAttribution: false,
      warmPercentiles: false,
    })).rejects.toThrow('PromotionRuntime Redis channel locks require a Redis client with get/set/exists');

    await expect(createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis: lockOnlyRedis as any,
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    })).rejects.toThrow('PromotionRuntime conversion attribution requires a Redis client with get/set/lrange/pipeline');

    await expect(createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis: {
        get: async () => null,
        set: async () => 'OK',
        lrange: async () => [],
        pipeline: () => ({ lpush: () => undefined }),
      } as any,
      enableLocks: false,
      enableAttribution: true,
      warmPercentiles: false,
    })).rejects.toThrow('PromotionRuntime conversion attribution requires a Redis client with get/set/lrange/pipeline');

    await expect(createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis: trackerOnlyRedis as any,
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    })).rejects.toThrow('PromotionRuntime Redis channel locks require a Redis client with get/set/exists');
  });

  it('clears stale directly initialized optional singletons on first runtime creation when features are disabled', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    const redis = new RedisMock();

    RedisChannelLock.init(redis as any);
    RedisPromotionTracker.init(redis as any);
    const intelligenceService = ChannelIntelligenceService.init(collection);
    ConversionAttributionService.init(intelligenceService, RedisPromotionTracker.getInstance());
    PercentileEngine.init(collection, redis as any);

    const runtime = await createPromotionRuntime({
      channelIntelligenceCollection: collection,
      activeChannelCollection: collection,
      redis: null,
      enableLocks: false,
      enableAttribution: false,
      enablePercentiles: false,
      warmPercentiles: false,
    });

    expect(runtime.percentiles).toBeNull();
    expect(runtime.channelLock).toBeNull();
    expect(runtime.tracker).toBeNull();
    expect(runtime.attribution).toBeNull();
    expect(() => PercentileEngine.getInstance()).toThrow('PercentileEngine not initialized');
    expect(() => RedisChannelLock.getInstance()).toThrow('RedisChannelLock not initialized');
    expect(() => RedisPromotionTracker.getInstance()).toThrow('RedisPromotionTracker not initialized');
    expect(() => ConversionAttributionService.getInstance()).toThrow('ConversionAttributionService not initialized');
  });

  it('replaces stale directly initialized singletons on first runtime creation when features are enabled', async () => {
    const staleCollection = new CollectionMock<ChannelIntelligenceDocument>();
    const runtimeCollection = new CollectionMock<ChannelIntelligenceDocument>();
    runtimeCollection.docs.set('runtime-channel', createDefaultIntelligence('runtime-channel'));
    const staleRedis = new RedisMock();
    const runtimeRedis = new RedisMock();

    RedisChannelLock.init(staleRedis as any);
    RedisPromotionTracker.init(staleRedis as any);
    ChannelIntelligenceService.init(staleCollection);
    PercentileEngine.init(staleCollection, staleRedis as any, staleCollection);

    const runtime = await createPromotionRuntime({
      channelIntelligenceCollection: runtimeCollection,
      activeChannelCollection: runtimeCollection,
      redis: runtimeRedis,
      enableLocks: true,
      enableAttribution: true,
      enablePercentiles: true,
      warmPercentiles: false,
    });

    const account = runtime.createAccountContext({ mobile: '919100000003', clientId: 'client-runtime' });
    await account.recordSuccess('runtime-channel', 'legacy', false);
    await account.recordSend('runtime-channel');
    await account.markPromoted('runtime-channel');

    expect(staleCollection.docs.get('runtime-channel')).toBeUndefined();
    expect(runtimeCollection.docs.get('runtime-channel')!.strategies.legacy.s).toBe(1);
    expect(staleRedis.values.size).toBe(0);
    expect(staleRedis.lists.size).toBe(0);
    expect(runtimeRedis.values.size).toBeGreaterThan(0);
    expect(runtimeRedis.lists.size).toBeGreaterThan(0);
    expect(runtime.channelLock).toBe(RedisChannelLock.getInstance());
    expect(runtime.tracker).toBe(RedisPromotionTracker.getInstance());
    expect(runtime.percentiles).toBe(PercentileEngine.getInstance());
  });

  it('replaces collection and redis-backed singletons when runtime is recreated', async () => {
    const firstCollection = new CollectionMock<ChannelIntelligenceDocument>();
    const secondCollection = new CollectionMock<ChannelIntelligenceDocument>();
    firstCollection.docs.set('old-channel', createDefaultIntelligence('old-channel'));
    secondCollection.docs.set('new-channel', createDefaultIntelligence('new-channel'));
    const firstRedis = new RedisMock();
    const secondRedis = new RedisMock();

    const firstRuntime = await createPromotionRuntime({
      channelIntelligenceCollection: firstCollection,
      activeChannelCollection: firstCollection,
      redis: firstRedis,
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    });
    await firstRuntime.createAccountContext({ mobile: '919100000001', clientId: 'client-a' }).recordSend('old-channel');

    const secondRuntime = await createPromotionRuntime({
      channelIntelligenceCollection: secondCollection,
      activeChannelCollection: secondCollection,
      redis: secondRedis,
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    });
    const secondAccount = secondRuntime.createAccountContext({ mobile: '919100000002', clientId: 'client-b' });
    await secondAccount.recordSuccess('new-channel', 'legacy', false);
    await secondAccount.recordSend('new-channel');
    await secondAccount.markPromoted('new-channel');

    expect(firstCollection.docs.get('new-channel')).toBeUndefined();
    expect(secondCollection.docs.get('new-channel')!.strategies.legacy.s).toBe(1);
    expect(await firstRuntime.tracker?.getLastPromoter('new-channel')).toBeNull();
    expect(await secondRuntime.tracker?.getLastPromoter('new-channel')).toEqual(expect.objectContaining({
      mobile: '919100000002',
      clientId: 'client-b',
    }));
    expect(await secondAccount.isRecentlyPromoted('new-channel')).toBe(true);
  });

  it('normalizes account identity and ignores blank channel ids at account boundary', async () => {
    const intelligence = new CollectionMock<ChannelIntelligenceDocument>();
    const redis = new RedisMock();

    const runtime = await createPromotionRuntime({
      channelIntelligenceCollection: intelligence,
      activeChannelCollection: intelligence,
      redis,
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    });

    expect(() => runtime.createAccountContext({ mobile: '   ', clientId: 'client-a' }))
      .toThrow('Promotion account mobile is required');
    expect(() => runtime.createAccountContext({ mobile: '919100000001', clientId: '' }))
      .toThrow('Promotion account clientId is required');
    expect(() => runtime.createAccountContext(null as unknown as Parameters<typeof runtime.createAccountContext>[0]))
      .toThrow('Promotion account mobile is required');
    expect(() => runtime.createAccountContext({ mobile: null as unknown as string, clientId: 'client-a' }))
      .toThrow('Promotion account mobile is required');

    const account = runtime.createAccountContext({ mobile: ' 919100000001 ', clientId: ' client-a ' });
    expect(account.mobile).toBe('919100000001');
    expect(account.clientId).toBe('client-a');

    await account.recordSend('   ');
    await account.markPromoted('');
    await account.recordSuccess(' ', 'legacy', false);
    await account.recordDeletion('', 'legacy', 1000, false);
    await account.recordFailure(' ', 'legacy', 'TRANSIENT');

    expect(await account.isRecentlyPromoted('')).toBe(false);
    expect(redis.values.size).toBe(0);
    expect(redis.lists.size).toBe(0);
    expect(intelligence.docs.size).toBe(0);
  });

  it('clears optional redis-backed services when runtime is recreated with features disabled', async () => {
    const collection = new CollectionMock<ChannelIntelligenceDocument>();
    collection.docs.set('ch1', createDefaultIntelligence('ch1'));

    const firstRuntime = await createPromotionRuntime({
      channelIntelligenceCollection: collection,
      activeChannelCollection: collection,
      redis: new RedisMock(),
      enableLocks: true,
      enableAttribution: true,
      warmPercentiles: false,
    });
    expect(firstRuntime.channelLock).not.toBeNull();
    expect(firstRuntime.tracker).not.toBeNull();
    expect(firstRuntime.attribution).not.toBeNull();

    const secondRuntime = await createPromotionRuntime({
      channelIntelligenceCollection: collection,
      activeChannelCollection: collection,
      redis: null,
      enableLocks: false,
      enableAttribution: false,
      warmPercentiles: false,
    });

    expect(secondRuntime.channelLock).toBeNull();
    expect(secondRuntime.tracker).toBeNull();
    expect(secondRuntime.attribution).toBeNull();
    expect(() => RedisChannelLock.getInstance()).toThrow('RedisChannelLock not initialized');
    expect(() => RedisPromotionTracker.getInstance()).toThrow('RedisPromotionTracker not initialized');
    expect(() => ConversionAttributionService.getInstance()).toThrow('ConversionAttributionService not initialized');
  });
});

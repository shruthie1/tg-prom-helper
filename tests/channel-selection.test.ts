import { selectPromotionChannels } from '../src';
import { createDefaultIntelligence } from '../src';
import type { ChannelIntelligenceDocument } from '../src';

interface TestChannel {
  channelId: string;
  title: string;
}

function doc(channelId: string, updates: Partial<ChannelIntelligenceDocument>): ChannelIntelligenceDocument {
  return {
    ...createDefaultIntelligence(channelId),
    ...updates,
  };
}

describe('selectPromotionChannels', () => {
  it('shares one deterministic proven/untested/stale split and backfills capacity', () => {
    const channels: TestChannel[] = [
      { channelId: 'best', title: 'best' },
      { channelId: 'weak', title: 'weak' },
      { channelId: 'new-doc', title: 'new' },
      { channelId: 'missing', title: 'missing' },
      { channelId: 'stale', title: 'stale' },
      { channelId: 'hostile', title: 'hostile' },
    ];
    const now = 10 * 86_400_000;
    const docs = [
      doc('best', { stage: 'optimized', expectedValue: 0.9, scoreUpdatedAt: now }),
      doc('weak', { stage: 'optimized', expectedValue: 0.2, scoreUpdatedAt: now }),
      doc('new-doc', { stage: 'new', expectedValue: 0.8, scoreUpdatedAt: now }),
      doc('stale', { stage: 'optimized', expectedValue: 0.95, scoreUpdatedAt: 1 }),
      doc('hostile', { stage: 'hostile', expectedValue: 0.99, scoreUpdatedAt: now }),
    ];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: docs,
      batchTarget: 5,
      now,
      random: () => 0.5,
    });

    expect(result.proven.map((ch) => ch.channelId)).toEqual(['best', 'weak']);
    expect(result.untested.map((ch) => ch.channelId).sort()).toEqual(['missing', 'new-doc']);
    expect(result.stale.map((ch) => ch.channelId)).toEqual(['stale']);
    expect(result.skipped.map((ch) => ch.channelId)).toEqual(['hostile']);
    expect(result.selected).toHaveLength(5);
    expect(result.selected.map((ch) => ch.channelId)).not.toContain('hostile');
  });

  it('returns no selected channels when batch target is zero or negative', () => {
    const channels: TestChannel[] = [
      { channelId: 'a', title: 'a' },
      { channelId: 'b', title: 'b' },
    ];

    expect(selectPromotionChannels({
      channels,
      intelligenceDocs: [],
      batchTarget: 0,
    }).selected).toEqual([]);

    expect(selectPromotionChannels({
      channels,
      intelligenceDocs: [],
      batchTarget: -5,
    }).selected).toEqual([]);
  });

  it('skips channels in cooldown while still backfilling from eligible channels', () => {
    const now = 1_000_000;
    const channels: TestChannel[] = [
      { channelId: 'cooldown', title: 'cooldown' },
      { channelId: 'eligible', title: 'eligible' },
      { channelId: 'missing', title: 'missing' },
    ];
    const docs = [
      doc('cooldown', { stage: 'optimized', cooldownUntil: now + 60_000, expectedValue: 0.99, scoreUpdatedAt: now }),
      doc('eligible', { stage: 'optimized', cooldownUntil: 0, expectedValue: 0.70, scoreUpdatedAt: now }),
    ];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: docs,
      batchTarget: 2,
      now,
      random: () => 0.5,
    });

    expect(result.skipped.map((channel) => channel.channelId)).toEqual(['cooldown']);
    expect(result.selected.map((channel) => channel.channelId).sort()).toEqual(['eligible', 'missing']);
  });

  it('uses injected randomness for proven-channel exploration instead of global Math.random', () => {
    const now = 1_000_000;
    const channels: TestChannel[] = [
      { channelId: 'a', title: 'a' },
      { channelId: 'b', title: 'b' },
    ];
    const docs = [
      doc('a', { stage: 'optimized', expectedValue: 0.70, scoreUpdatedAt: now }),
      doc('b', { stage: 'optimized', expectedValue: 0.60, scoreUpdatedAt: now }),
    ];
    const originalRandom = Math.random;
    Math.random = () => {
      throw new Error('global randomness used');
    };

    try {
      const result = selectPromotionChannels({
        channels,
        intelligenceDocs: docs,
        batchTarget: 2,
        now,
        random: () => 0.5,
      });

      expect(result.selected).toHaveLength(2);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('clamps malformed expected values before scoring proven channels', () => {
    const now = 1_000_000;
    const channels: TestChannel[] = [
      { channelId: 'too-high', title: 'too-high' },
      { channelId: 'too-low', title: 'too-low' },
      { channelId: 'nan', title: 'nan' },
    ];
    const docs = [
      doc('too-high', { stage: 'optimized', expectedValue: 5, scoreUpdatedAt: now }),
      doc('too-low', { stage: 'optimized', expectedValue: -2, scoreUpdatedAt: now }),
      doc('nan', { stage: 'optimized', expectedValue: Number.NaN, scoreUpdatedAt: now }),
    ];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: docs,
      batchTarget: 3,
      now,
      random: () => 0.5,
    });

    expect(result.proven).toHaveLength(3);
    expect(result.selected.map((channel) => channel.channelId).sort()).toEqual(['nan', 'too-high', 'too-low']);
  });

  it('normalizes malformed selection options and random values', () => {
    const channels: TestChannel[] = [
      { channelId: 'fresh', title: 'fresh' },
      { channelId: 'stale', title: 'stale' },
      { channelId: 'cooldown-invalid', title: 'cooldown-invalid' },
    ];
    const docs = [
      doc('fresh', { stage: 'optimized', expectedValue: 0.7, scoreUpdatedAt: 1_000, cooldownUntil: Number.NaN }),
      doc('stale', { stage: 'optimized', expectedValue: 0.8, scoreUpdatedAt: Number.NaN }),
      doc('cooldown-invalid', { stage: 'optimized', expectedValue: 0.9, scoreUpdatedAt: 1_000 }),
    ];

    expect(selectPromotionChannels({
      channels,
      intelligenceDocs: docs,
      batchTarget: Number.NaN,
      now: Number.NaN,
      staleAfterMs: Number.NaN,
      minExplorePercent: Number.NaN,
      maxExplorePercent: -1,
      reEvalPercent: 99,
      expectedValueWeight: Number.NaN,
      explorationWeight: Number.NaN,
      random: () => Number.NaN,
    }).selected).toEqual([]);

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: docs,
      batchTarget: 3,
      now: 1_000,
      staleAfterMs: 100,
      random: () => Number.NaN,
    });

    expect(result.stale.map(channel => channel.channelId)).toEqual(['stale']);
    expect(result.skipped).toEqual([]);
    expect(result.selected).toHaveLength(3);
  });

  it('never returns more channels than batch target when ratio options overlap', () => {
    const now = 1_000_000;
    const channels: TestChannel[] = [
      { channelId: 'proven', title: 'proven' },
      { channelId: 'untested-a', title: 'untested-a' },
      { channelId: 'untested-b', title: 'untested-b' },
      { channelId: 'stale-a', title: 'stale-a' },
      { channelId: 'stale-b', title: 'stale-b' },
    ];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: [
        doc('proven', { stage: 'optimized', expectedValue: 0.8, scoreUpdatedAt: now }),
        doc('stale-a', { stage: 'optimized', expectedValue: 0.7, scoreUpdatedAt: 1 }),
        doc('stale-b', { stage: 'optimized', expectedValue: 0.7, scoreUpdatedAt: 1 }),
      ],
      batchTarget: 2,
      now,
      staleAfterMs: 100,
      minExplorePercent: 1,
      maxExplorePercent: 1,
      reEvalPercent: 1,
      random: () => 0.5,
    });

    expect(result.selected).toHaveLength(2);
  });

  it('backfills tiny batches from proven channels before untested channels', () => {
    const now = 1_000_000;
    const channels: TestChannel[] = [
      { channelId: 'proven-low', title: 'proven-low' },
      { channelId: 'untested', title: 'untested' },
    ];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: [
        doc('proven-low', { stage: 'optimized', expectedValue: 0.1, scoreUpdatedAt: now }),
      ],
      batchTarget: 1,
      now,
      random: () => 0.5,
    });

    expect(result.selected.map(channel => channel.channelId)).toEqual(['proven-low']);
  });

  it('skips blank and duplicate channel ids before selecting a batch', () => {
    const now = 1_000_000;
    const channels: TestChannel[] = [
      { channelId: ' alpha ', title: 'alpha raw' },
      { channelId: 'alpha', title: 'alpha duplicate' },
      { channelId: '   ', title: 'blank' },
      { channelId: 'beta', title: 'beta' },
    ];
    const docs = [
      doc('alpha', { stage: 'optimized', expectedValue: 0.9, scoreUpdatedAt: now }),
      doc(' beta ', { stage: 'optimized', expectedValue: 0.8, scoreUpdatedAt: now }),
    ];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: docs,
      batchTarget: 4,
      now,
      random: () => 0.5,
    });

    expect(result.selected.map(channel => channel.channelId).sort()).toEqual(['alpha', 'beta']);
    expect(result.skipped.map(channel => channel.title).sort()).toEqual(['alpha duplicate', 'blank']);
  });

  it('ignores malformed channel rows and malformed option objects from JavaScript callers', () => {
    const now = 1_000_000;
    const channels = [
      null,
      123,
      { channelId: 'valid', title: 'valid' },
      { title: 'missing id' },
    ] as unknown as TestChannel[];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: [
        doc('valid', { stage: 'optimized', expectedValue: 0.8, scoreUpdatedAt: now }),
      ],
      batchTarget: 2,
      now,
      random: () => 0.5,
    });

    expect(result.selected.map(channel => channel.channelId)).toEqual(['valid']);
    expect(result.skipped.map(channel => channel.title)).toEqual(['missing id']);

    expect(selectPromotionChannels(null as unknown as Parameters<typeof selectPromotionChannels<TestChannel>>[0]))
      .toEqual({
        selected: [],
        proven: [],
        untested: [],
        stale: [],
        skipped: [],
        explorePercent: 0.15,
        reEvalPercent: 0.10,
      });
  });

  it('uses normalized ids for proven ranking and ignores malformed intelligence docs', () => {
    const now = 1_000_000;
    const channels: TestChannel[] = [
      { channelId: ' high ', title: 'high' },
      { channelId: 'low', title: 'low' },
    ];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: [
        null as unknown as ChannelIntelligenceDocument,
        doc(' high ', { stage: 'optimized', expectedValue: 0.95, scoreUpdatedAt: now }),
        doc('low', { stage: 'optimized', expectedValue: 0.10, scoreUpdatedAt: now }),
      ],
      batchTarget: 2,
      now,
      random: () => 0.5,
    });

    expect(result.proven.map(channel => channel.channelId)).toEqual(['high', 'low']);
    expect(result.selected.map(channel => channel.channelId).sort()).toEqual(['high', 'low']);
  });

  it('treats Telegram-prefixed channel ids as the same selection identity', () => {
    const now = 1_000_000;
    const channels: TestChannel[] = [
      { channelId: '-100777', title: 'prefixed channel' },
      { channelId: '777', title: 'duplicate stripped channel' },
      { channelId: '-888', title: 'negative channel' },
    ];

    const result = selectPromotionChannels({
      channels,
      intelligenceDocs: [
        doc('777', { stage: 'optimized', expectedValue: 0.95, scoreUpdatedAt: now }),
        doc('-100888', { stage: 'optimized', expectedValue: 0.90, scoreUpdatedAt: now }),
      ],
      batchTarget: 3,
      now,
      random: () => 0.5,
    });

    expect(result.proven.map(channel => channel.channelId).sort()).toEqual(['777', '888']);
    expect(result.selected.map(channel => channel.channelId).sort()).toEqual(['777', '888']);
    expect(result.skipped.map(channel => channel.title)).toEqual(['duplicate stripped channel']);
  });
});

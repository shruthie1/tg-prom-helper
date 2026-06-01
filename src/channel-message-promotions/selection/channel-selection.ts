import type { ChannelIntelligenceDocument } from '../channel-intelligence';
import { betaSample } from '../message-strategy';
import { normalizeChannelId } from '../utils/channel-id';

export interface ChannelSelectionInput {
  channelId: string;
}

export interface ChannelSelectionOptions<TChannel extends ChannelSelectionInput> {
  channels: TChannel[];
  intelligenceDocs: ChannelIntelligenceDocument[];
  batchTarget: number;
  now?: number;
  staleAfterMs?: number;
  minExplorePercent?: number;
  maxExplorePercent?: number;
  reEvalPercent?: number;
  expectedValueWeight?: number;
  explorationWeight?: number;
  random?: () => number;
}

export interface ChannelSelectionResult<TChannel extends ChannelSelectionInput> {
  selected: TChannel[];
  proven: TChannel[];
  untested: TChannel[];
  stale: TChannel[];
  skipped: TChannel[];
  explorePercent: number;
  reEvalPercent: number;
}

const DEFAULT_STALE_AFTER_MS = 7 * 86_400_000;

function shuffle<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(safeUnitRandom(random) * (i + 1));
    const current = items[i];
    const replacement = items[j];
    if (current === undefined || replacement === undefined) continue;
    items[i] = replacement;
    items[j] = current;
  }
}

export function selectPromotionChannels<TChannel extends ChannelSelectionInput>(
  options: ChannelSelectionOptions<TChannel>,
): ChannelSelectionResult<TChannel> {
  const safeOptions = isRecord(options) ? options as Partial<ChannelSelectionOptions<TChannel>> : {};
  const {
    channels: inputChannels,
    intelligenceDocs: inputIntelligenceDocs,
    batchTarget: inputBatchTarget = 0,
    now: inputNow = Date.now(),
    staleAfterMs: inputStaleAfterMs = DEFAULT_STALE_AFTER_MS,
    minExplorePercent: inputMinExplorePercent = 0.15,
    maxExplorePercent: inputMaxExplorePercent = 0.35,
    reEvalPercent: inputReEvalPercent = 0.10,
    expectedValueWeight: inputExpectedValueWeight = 0.85,
    explorationWeight: inputExplorationWeight = 0.15,
    random = Math.random,
  } = safeOptions;

  const channels = Array.isArray(inputChannels) ? inputChannels : [];
  const intelligenceDocs = Array.isArray(inputIntelligenceDocs) ? inputIntelligenceDocs : [];
  const now = safeTimestamp(inputNow, Date.now());
  const staleAfterMs = safePositive(inputStaleAfterMs, DEFAULT_STALE_AFTER_MS);
  const minExplorePercent = clampRatio(inputMinExplorePercent, 0.15);
  const maxExplorePercent = Math.max(minExplorePercent, clampRatio(inputMaxExplorePercent, 0.35));
  const reEvalPercent = clampRatio(inputReEvalPercent, 0.10);
  const expectedValueWeight = clampRatio(inputExpectedValueWeight, 0.85);
  const explorationWeight = clampRatio(inputExplorationWeight, 0.15);
  const intelligenceByChannel = new Map<string, ChannelIntelligenceDocument>();
  for (const doc of intelligenceDocs) {
    if (!isChannelIntelligenceDocument(doc)) continue;
    const normalizedDocId = normalizeChannelId(doc.channelId);
    if (normalizedDocId && !intelligenceByChannel.has(normalizedDocId)) {
      intelligenceByChannel.set(normalizedDocId, doc);
    }
  }

  const rankScores = new Map<string, number>();
  const proven: TChannel[] = [];
  const untested: TChannel[] = [];
  const stale: TChannel[] = [];
  const skipped: TChannel[] = [];
  const seenChannelIds = new Set<string>();
  const validChannels: TChannel[] = [];

  for (const rawChannel of channels as unknown[]) {
    const channel = normalizeChannel<TChannel>(rawChannel);
    if (!channel) {
      if (isRecord(rawChannel)) skipped.push(rawChannel as TChannel);
      continue;
    }
    const channelId = normalizeChannelId(channel.channelId);
    if (!channelId || seenChannelIds.has(channelId)) {
      skipped.push(channel);
      continue;
    }
    seenChannelIds.add(channelId);
    validChannels.push(channel);
  }

  const safeBatchTarget = Number.isFinite(inputBatchTarget) ? Math.floor(inputBatchTarget) : 0;
  const batchTarget = Math.max(0, Math.min(safeBatchTarget, validChannels.length));

  for (const channel of validChannels) {
    const channelId = normalizeChannelId(channel.channelId);
    if (!channelId) {
      skipped.push(channel);
      continue;
    }
    const doc = intelligenceByChannel.get(channelId);
    if (!doc || doc.stage === 'new') {
      untested.push(channel);
    } else if (safeTimestamp(doc.cooldownUntil, 0) > now || doc.stage === 'hostile') {
      skipped.push(channel);
    } else if (safeTimestamp(doc.scoreUpdatedAt, 0) < now - staleAfterMs) {
      stale.push(channel);
    } else {
      const expectedValue = clamp01(doc.expectedValue, 0.5);
      const alpha = expectedValue * 50 + 1;
      const beta = (1 - expectedValue) * 50 + 1;
      const explorationSample = betaSample(alpha, beta, random);
      rankScores.set(
        channelId,
        expectedValue * expectedValueWeight + explorationSample * explorationWeight,
      );
      proven.push(channel);
    }
  }

  proven.sort((a, b) => {
    const aChannelId = normalizeChannelId(a.channelId);
    const bChannelId = normalizeChannelId(b.channelId);
    return (rankScores.get(bChannelId ?? '') || 0) - (rankScores.get(aChannelId ?? '') || 0);
  });
  shuffle(untested, random);
  shuffle(stale, random);

  const untestedRatio = untested.length / Math.max(1, validChannels.length);
  const explorePercent = Math.min(maxExplorePercent, Math.max(minExplorePercent, untestedRatio));
  const exploitPercent = Math.max(0, 1 - explorePercent - reEvalPercent);

  const selected = [
    ...proven.slice(0, Math.floor(batchTarget * exploitPercent)),
    ...untested.slice(0, Math.floor(batchTarget * explorePercent)),
    ...stale.slice(0, Math.floor(batchTarget * reEvalPercent)),
  ];
  if (selected.length > batchTarget) selected.length = batchTarget;

  if (selected.length < batchTarget) {
    const selectedIds = new Set(selected.map((channel) => normalizeChannelId(channel.channelId)).filter(Boolean));
    const remaining = [...proven, ...stale, ...untested]
      .filter((channel) => {
        const channelId = normalizeChannelId(channel.channelId);
        return channelId !== null && !selectedIds.has(channelId);
      })
      .sort((a, b) => {
        const aChannelId = normalizeChannelId(a.channelId);
        const bChannelId = normalizeChannelId(b.channelId);
        const aPriority = getBackfillPriority(aChannelId, proven, stale);
        const bPriority = getBackfillPriority(bChannelId, proven, stale);
        if (aPriority !== bPriority) return bPriority - aPriority;
        return (rankScores.get(bChannelId ?? '') || 0) - (rankScores.get(aChannelId ?? '') || 0);
      });
    selected.push(...remaining.slice(0, batchTarget - selected.length));
  }

  shuffle(selected, random);

  return {
    selected,
    proven,
    untested,
    stale,
    skipped,
    explorePercent,
    reEvalPercent,
  };
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.001, Math.min(0.999, value));
}

function clampRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function safePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeChannel<TChannel extends ChannelSelectionInput>(value: unknown): TChannel | null {
  if (!isRecord(value)) return null;
  const channelId = normalizeChannelId(value['channelId']);
  if (!channelId) return null;
  return {
    ...value,
    channelId,
  } as TChannel;
}

function getBackfillPriority<TChannel extends ChannelSelectionInput>(
  channelId: string | null,
  proven: TChannel[],
  stale: TChannel[],
): number {
  if (!channelId) return 0;
  if (proven.some((channel) => normalizeChannelId(channel.channelId) === channelId)) return 2;
  if (stale.some((channel) => normalizeChannelId(channel.channelId) === channelId)) return 1;
  return 0;
}

function isChannelIntelligenceDocument(value: unknown): value is ChannelIntelligenceDocument {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && normalizeChannelId((value as { channelId?: unknown }).channelId) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeUnitRandom(random: () => number): number {
  try {
    const value = random();
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(0.999999999, value));
  } catch {
    return 0.5;
  }
}

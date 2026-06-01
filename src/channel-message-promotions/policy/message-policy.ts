import type { MessageStrategy } from '../channel-intelligence';
import type { MessagePolicyInput, PromotionMessageCandidate } from './policy.types';
import { safeNonNegative, safeUnitRandom } from './policy-number-utils';

export function selectPromotionMessageCandidates(input: MessagePolicyInput): PromotionMessageCandidate[] {
  const malformedInput = !isRecord(input);
  const safeInput = malformedInput ? {} : input as Partial<MessagePolicyInput>;
  const {
    isFollowUp = false,
    wordRestriction = 0,
    dMRestriction = 0,
    deletedCount = 0,
    failStreak = 0,
    banditStrategy = null,
    availableMessageIds,
    random = malformedInput ? (() => 0.5) : Math.random,
  } = safeInput;
  const safeBanditStrategy = normalizeMessageStrategy(banditStrategy);
  const safeIsFollowUp = isFollowUp === true;

  if (safeBanditStrategy && !safeIsFollowUp) {
    return selectBanditCandidates(safeBanditStrategy, failStreak, availableMessageIds, random);
  }

  if (safeIsFollowUp) {
    const candidates: PromotionMessageCandidate[] = [];
    if (safeNonNegative(dMRestriction) < 2) {
      candidates.push({ kind: 'followUp', randomIndex: 'followUp', strategy: null });
    } else {
      candidates.push({ kind: 'legacy', randomIndex: pickMessageId(availableMessageIds, random), strategy: 'legacy' });
    }
    candidates.push({ kind: 'fallback', randomIndex: '0', strategy: 'legacy' });
    return candidates;
  }

  const safeDeletedCount = safeNonNegative(deletedCount);
  const safeFailStreak = safeNonNegative(failStreak);
  if (safeNonNegative(wordRestriction) === 0) {
    if (safeUnitRandom(random) > 0.5 && safeDeletedCount < 4 && safeFailStreak < 3) {
      return [
        { kind: 'ai', randomIndex: 'ai', strategy: 'ai_contextual' },
        { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
        { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
      ];
    }
    return [
      { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
      { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
    ];
  }

  const candidates: PromotionMessageCandidate[] = [];
  if (safeDeletedCount > 20 && safeFailStreak < 3) {
    candidates.push({ kind: 'ai', randomIndex: 'ai', strategy: 'ai_contextual' });
  }
  candidates.push({ kind: 'legacy', randomIndex: pickMessageId(availableMessageIds, random), strategy: 'legacy' });
  candidates.push({ kind: 'fallback', randomIndex: '0', strategy: 'legacy' });
  return candidates;
}

export function messageIndexToStrategy(randomIndex: string): MessageStrategy | null {
  switch (normalizeMessageIndex(randomIndex)) {
    case 'ai':
      return 'ai_contextual';
    case 'custom':
      return 'natural_template';
    case 'followUp':
      return null;
    default:
      return 'legacy';
  }
}

function selectBanditCandidates(
  banditStrategy: MessageStrategy,
  failStreak: number,
  availableMessageIds: unknown,
  random: () => number,
): PromotionMessageCandidate[] {
  if (banditStrategy === 'ai_contextual' && safeNonNegative(failStreak) < 3) {
    return [
      { kind: 'ai', randomIndex: 'ai', strategy: banditStrategy },
      { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
      { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
    ];
  }

  if (banditStrategy === 'ai_contextual') {
    return [
      { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
      { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
    ];
  }

  if (banditStrategy === 'legacy') {
    return [
      { kind: 'legacy', randomIndex: pickMessageId(availableMessageIds, random), strategy: banditStrategy },
      { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
      { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
    ];
  }

  return [
    { kind: 'custom', randomIndex: 'custom', strategy: 'natural_template' },
    { kind: 'fallback', randomIndex: '0', strategy: 'legacy' },
  ];
}

function pickMessageId(ids: unknown, random: () => number): string {
  if (!Array.isArray(ids)) return '0';
  const validIds = ids
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter((id) => id.length > 0);
  if (validIds.length === 0) return '0';
  return validIds[Math.floor(safeUnitRandom(random) * validIds.length)] || '0';
}

function normalizeMessageIndex(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMessageStrategy(value: unknown): MessageStrategy | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized === 'ai_contextual'
    || normalized === 'markov_chain'
    || normalized === 'natural_template'
    || normalized === 'question_doubt'
    || normalized === 'curiosity_gap'
    || normalized === 'legacy'
    ? normalized as MessageStrategy
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

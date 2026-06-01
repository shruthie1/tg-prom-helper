/**
 * Data-driven channel classification.
 *
 * Replaces hardcoded keyword filtering in getActiveChannels().
 * Uses keyword matching as a SIGNAL (not a gate) combined with actual promotion results.
 * Performance data overrides keywords when confident.
 */

import type {
  ChannelCategory,
  ChannelIntelligenceDocument,
} from './channel-intelligence.types';

export interface ClassificationResult {
  category: ChannelCategory;
  confidence: number;
  promotionFitScore: number;
}

// Keyword lists — used as soft signals, NOT hard gates
const HIGH_INTENT_KEYWORDS = [
  'wife', 'adult', 'dating', 'coupl', 'swap', 'sex', 'escort',
  'intimate', 'hook', 'paid', 'call girl', 'massage', 'companion',
];

const SOCIAL_CHAT_KEYWORDS = [
  'chat', 'friend', 'girl', 'boy', 'love', 'romance', 'flirt',
  'single', 'meet', 'connect', 'relationship', 'desi', 'bhabhi',
  'aunty', 'hot', 'sexy', 'beautiful',
];

const OFF_TOPIC_KEYWORDS = [
  'crypto', 'bitcoin', 'game', 'movie', 'film', 'news', 'tech',
  'education', 'course', 'job', 'finance', 'invest', 'trade',
  'sport', 'cric', 'bet', 'coding', 'program', 'forex', 'nft',
  'stock', 'mutual fund', 'exam', 'upsc', 'ssc',
];

function safeNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function safeExpectedValue(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) return 0.5;
  return value;
}

export class ChannelClassifier {
  /**
   * Classify a channel based on its title, username, AND historical performance.
   * Performance data overrides keywords when confident enough.
   */
  static classify(
    title: string,
    username: string | null,
    intelDoc: ChannelIntelligenceDocument | null,
  ): ClassificationResult {
    const text = `${safeText(title).toLowerCase()} ${safeText(username).toLowerCase()}`;

    const highIntentHits = HIGH_INTENT_KEYWORDS.filter(k => text.includes(k)).length;
    const socialChatHits = SOCIAL_CHAT_KEYWORDS.filter(k => text.includes(k)).length;
    const offTopicHits = OFF_TOPIC_KEYWORDS.filter(k => text.includes(k)).length;

    // Signal 2: Historical promotion performance (strongest signal)
    let performanceCategory: ChannelCategory = 'unclassified';
    let performanceConfidence = 0;

    if (intelDoc && intelDoc.stage !== 'new') {
      const totalPulls = Object.values(asRecord(intelDoc.strategies)).reduce<number>((sum, arm) => {
        const armRecord = asRecord(arm);
        return sum + safeNonNegative(armRecord['n']);
      }, 0);

      if (totalPulls >= 10) {
        const ev = safeExpectedValue(intelDoc.expectedValue);
        const conversions = safeNonNegative(intelDoc.conversions)
          + safeNonNegative(intelDoc.paidConversions) * 2;

        // Channels that ACTUALLY convert are high_intent regardless of keywords
        if (conversions > 0.5) {
          performanceCategory = 'high_intent';
          performanceConfidence = clamp01(conversions / 3, 0);
        } else if (ev >= 0.7) {
          performanceCategory = 'social_chat';
          performanceConfidence = clamp01((ev - 0.5) * 2, 0);
        } else if (ev < 0.3) {
          performanceCategory = 'off_topic';
          performanceConfidence = clamp01((0.5 - ev) * 2, 0);
        }
      }
    }

    // Combine: performance data overrides keywords when confident
    let category: ChannelCategory;
    let confidence: number;

    if (performanceConfidence > 0.5) {
      category = performanceCategory;
      confidence = performanceConfidence;
    } else if (highIntentHits >= 2 || (highIntentHits >= 1 && offTopicHits === 0)) {
      category = 'high_intent';
      confidence = Math.min(0.7, highIntentHits * 0.25);
    } else if (offTopicHits >= 2) {
      category = 'off_topic';
      confidence = Math.min(0.7, offTopicHits * 0.2);
    } else if (socialChatHits >= 1) {
      category = 'social_chat';
      confidence = Math.min(0.5, socialChatHits * 0.2);
    } else {
      category = 'unclassified';
      confidence = 0;
    }

    // promotionFitScore: 0-1
    const keywordFit = (highIntentHits * 0.3 + socialChatHits * 0.15)
      / Math.max(1, highIntentHits + socialChatHits + offTopicHits);
    const performanceFit = intelDoc ? safeExpectedValue(intelDoc.expectedValue) : 0.5;
    const promotionFitScore = performanceConfidence > 0.3
      ? performanceFit * 0.8 + keywordFit * 0.2
      : keywordFit * 0.5 + 0.25;

    return { category, confidence: clamp01(confidence, 0), promotionFitScore: clamp01(promotionFitScore, 0.25) };
  }
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

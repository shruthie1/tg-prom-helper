import type { PromotionQueuedMessage } from './promotion-flow.types';
import { type MessageStrategy } from '../channel-intelligence';
import { PROMOTION_MESSAGE_STRATEGIES } from '../message-strategy';
import { normalizeChannelId } from '../utils/channel-id';

export class PromotionMessageQueue {
  private readonly items: PromotionQueuedMessage[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 500) {
    this.maxSize = Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : 500;
  }

  get size(): number {
    return this.items.length;
  }

  enqueue(message: PromotionQueuedMessage): void {
    const normalized = normalizeQueuedMessage(message);
    if (!normalized) return;
    this.items.push(normalized);
    if (this.items.length > this.maxSize) {
      this.items.splice(0, this.items.length - this.maxSize);
    }
  }

  isQueued(channelId: string): boolean {
    const safeChannelId = normalizeChannelId(channelId);
    if (!safeChannelId) return false;
    return this.items.some((message) => message.channelId === safeChannelId);
  }

  readyForCheck(now: number, delayMs: number): PromotionQueuedMessage[] {
    const safeNow = Number.isFinite(now) && now > 0 ? now : Date.now();
    const safeDelayMs = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
    return this.items.filter((message) => safeNow - safeQueuedTimestamp(message.timestamp, safeNow) >= safeDelayMs);
  }

  remove(message: PromotionQueuedMessage): void {
    const index = this.items.indexOf(message);
    if (index >= 0) this.items.splice(index, 1);
  }

  clear(): void {
    this.items.length = 0;
  }
}

function normalizeQueuedMessage(message: unknown): PromotionQueuedMessage | null {
  if (!isRecord(message)) return null;
  const channelId = normalizeChannelId(message['channelId']);
  const messageId = message['messageId'];
  if (!channelId || !isValidMessageId(messageId)) return null;
  const rawTimestamp = message['timestamp'];
  const timestamp = typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp) && rawTimestamp > 0
    ? Math.floor(rawTimestamp)
    : 0;
  const rawAvailableMessageCount = message['availableMessageCount'];
  const availableMessageCount = typeof rawAvailableMessageCount === 'number' && Number.isFinite(rawAvailableMessageCount) && rawAvailableMessageCount > 0
    ? Math.floor(rawAvailableMessageCount)
    : null;
  const strategy = normalizeMessageStrategy(message['strategy']);
  return {
    channelId,
    messageId,
    messageIndex: normalizeMessageIndex(message['messageIndex']),
    ...(strategy ? { strategy } : {}),
    isFollowUp: message['isFollowUp'] === true,
    timestamp,
    ...(availableMessageCount !== null ? { availableMessageCount } : {}),
  };
}

function isValidMessageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeMessageIndex(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '0';
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

function safeQueuedTimestamp(timestamp: number, now: number): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now) return 0;
  return timestamp;
}

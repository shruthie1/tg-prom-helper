import { Api } from 'telegram';
import bigInt from 'big-integer';

import { normalizeChannelId } from '../channel-state';

export interface TelegramCommonChatsClient {
  invoke(request: unknown): Promise<TelegramCommonChatsResult | null | undefined>;
}

export interface TelegramCommonChatSnapshot {
  id?: unknown;
}

export interface TelegramCommonChatsResult {
  chats?: TelegramCommonChatSnapshot[] | null;
}

export interface TelegramCommonChatIdsInput {
  userId: unknown;
  limit?: number;
  maxId?: unknown;
}

export async function getTelegramCommonChatIds(
  client: TelegramCommonChatsClient,
  input: TelegramCommonChatIdsInput,
): Promise<string[]> {
  if (!client || typeof client.invoke !== 'function') {
    throw new Error('Telegram client with invoke is required');
  }

  const limit = normalizeLimit(input.limit);
  const request = new Api.messages.GetCommonChats({
    userId: input.userId as Api.TypeEntityLike,
    maxId: normalizeMaxId(input.maxId),
    limit,
  });

  try {
    const result = await client.invoke(request);
    const chats = Array.isArray(result?.chats) ? result.chats : [];
    const seen = new Set<string>();
    const commonChatIds: string[] = [];
    for (const chat of chats) {
      const channelId = normalizeChannelId(chat?.id);
      if (!channelId || seen.has(channelId)) continue;
      seen.add(channelId);
      commonChatIds.push(channelId);
    }
    return commonChatIds;
  } catch (error) {
    throw new Error(`Failed to get common chats: ${formatTelegramCommonChatsError(error)}`);
  }
}

function normalizeLimit(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return Math.min(Math.floor(input), 500);
  }
  return 100;
}

function normalizeMaxId(input: unknown): ReturnType<typeof bigInt> {
  if (input && typeof input === 'object' && typeof (input as { toString?: unknown }).toString === 'function') {
    return bigInt((input as { toString(): string }).toString());
  }
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return bigInt(input);
  if (typeof input === 'string' && input.trim()) return bigInt(input);
  return bigInt(0);
}

function formatTelegramCommonChatsError(error: unknown): string {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const errorMessage = String(record?.['errorMessage'] || record?.['message'] || error || '').trim();
  return errorMessage || 'Unknown Telegram API error';
}

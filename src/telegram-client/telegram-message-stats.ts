export interface TelegramMessageSnapshot {
  date?: number | null;
  message?: string | null;
  fromId?: unknown;
}

export interface TelegramMessageHistoryClient {
  iterMessages(peer: unknown, options: { limit: number }): AsyncIterable<TelegramMessageSnapshot | null | undefined>;
}

export interface TelegramChannelMessageStats {
  totalMessages: number;
  uniqueUsers: number;
  matchingMessages?: number;
  userIds: Set<string>;
}

export interface TelegramChannelMessageStatsInput {
  channelId: unknown;
  messageLimit: number;
  regex?: RegExp;
  now?: number;
  lookbackMs?: number;
}

export async function getTelegramChannelMessageStats(
  client: TelegramMessageHistoryClient,
  input: TelegramChannelMessageStatsInput,
): Promise<TelegramChannelMessageStats> {
  if (!client || typeof client.iterMessages !== 'function') {
    throw new Error('Telegram client with iterMessages is required');
  }
  const messageLimit = normalizePositiveInteger(input.messageLimit);
  if (messageLimit <= 0) {
    throw new Error('messageLimit must be greater than 0');
  }

  const userIds = new Set<string>();
  let matchingMessages = 0;
  let totalMessages = 0;
  const lookbackMs = normalizePositiveInteger(input.lookbackMs) || 24 * 60 * 60 * 1000;
  const cutoffTimestamp = (normalizePositiveInteger(input.now) || Date.now()) - lookbackMs;

  try {
    for await (const message of client.iterMessages(input.channelId, { limit: messageLimit })) {
      if (!message) continue;
      if (!message.date || message.date * 1000 < cutoffTimestamp) continue;
      totalMessages++;

      const userId = extractTelegramPeerId(message.fromId);
      if (userId) userIds.add(userId);

      if (input.regex && message.message && regexMatches(input.regex, message.message)) {
        matchingMessages++;
      }
    }
  } catch (error) {
    throw new Error(`Failed to get channel message stats: ${formatTelegramHistoryError(error)}`);
  }

  const result: TelegramChannelMessageStats = {
    totalMessages,
    uniqueUsers: userIds.size,
    userIds,
  };
  if (input.regex !== undefined) result.matchingMessages = matchingMessages;
  return result;
}

function extractTelegramPeerId(fromId: unknown): string | null {
  if (!fromId || typeof fromId !== 'object') return null;
  const record = fromId as Record<string, unknown>;
  for (const key of ['userId', 'channelId', 'chatId']) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  const fallback = String(fromId).trim();
  return fallback && fallback !== '[object Object]' ? fallback : null;
}

function formatTelegramHistoryError(error: unknown): string {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const errorMessage = String(record?.['errorMessage'] || record?.['message'] || error || '').trim();
  switch (errorMessage) {
    case 'CHANNEL_PRIVATE':
      return 'Channel is private and not accessible';
    case 'CHANNEL_INVALID':
      return 'Invalid channel ID provided';
    case 'CHAT_ADMIN_REQUIRED':
      return 'Admin rights required to access channel history';
    default:
      return errorMessage || 'Unknown Telegram API error';
  }
}

function regexMatches(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  const matched = regex.test(value);
  regex.lastIndex = 0;
  return matched;
}

function normalizePositiveInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 0;
}

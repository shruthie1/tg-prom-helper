import {
  computeLiveCanSendMsgs,
  deriveTelegramChannelLiveFacts,
  normalizeChannelId,
  type DefaultBannedRightsSnapshot,
  type TelegramChannelLiveFacts,
} from '../channel-state';

export interface TelegramEntityLookupClient {
  getEntity(peer: unknown): Promise<unknown>;
}

export interface TelegramChannelEntitySnapshot {
  id?: unknown;
  title?: unknown;
  username?: unknown;
  participantsCount?: unknown;
  restricted?: unknown;
  broadcast?: unknown;
  left?: unknown;
  megagroup?: unknown;
  defaultBannedRights?: unknown;
  accessHash?: unknown;
}

export interface TelegramChannelLiveFactsInput {
  channelId: unknown;
  peer?: unknown;
  entity?: TelegramChannelEntitySnapshot | unknown;
  resolveParticipantsCount?: (
    entity: unknown,
    normalizedChannelId: string,
  ) => Promise<number | null | undefined> | number | null | undefined;
}

export type ResolvedTelegramChannelLiveFacts = ReturnType<typeof deriveTelegramChannelLiveFacts> & {
  canSendMsgs: boolean;
};

export async function getTelegramChannelLiveFacts(
  client: TelegramEntityLookupClient,
  input: TelegramChannelLiveFactsInput,
): Promise<ResolvedTelegramChannelLiveFacts | null> {
  const normalizedChannelId = normalizeChannelId(input.channelId);
  if (!normalizedChannelId || !/^\d+$/.test(normalizedChannelId) || normalizedChannelId === '0') {
    return null;
  }

  const entity = input.entity ?? await getEntityFromClient(client, input.peer ?? `-100${normalizedChannelId}`);
  if (!isRecord(entity)) return null;

  const participantsCount = await resolveParticipantsCount(entity, normalizedChannelId, input.resolveParticipantsCount);
  const factsInput: TelegramChannelLiveFacts = {
    channelId: normalizedChannelId,
    title: stringOrNull(entity['title']),
    username: stringOrNull(entity['username']),
    participantsCount,
    restricted: entity['restricted'] === true,
    broadcast: entity['broadcast'] === true,
    left: entity['left'] === true,
    defaultBannedRights: extractDefaultBannedRights(entity['defaultBannedRights']),
    megagroup: entity['megagroup'] === true,
    accessHash: stringOrNull(entity['accessHash']),
  };

  const liveFacts = deriveTelegramChannelLiveFacts(factsInput);
  return {
    ...liveFacts,
    canSendMsgs: computeLiveCanSendMsgs(liveFacts),
  };
}

async function getEntityFromClient(client: TelegramEntityLookupClient, peer: unknown): Promise<unknown> {
  if (!client || typeof client.getEntity !== 'function') {
    throw new Error('Telegram client with getEntity is required');
  }
  return client.getEntity(peer);
}

async function resolveParticipantsCount(
  entity: Record<string, unknown>,
  normalizedChannelId: string,
  resolver?: TelegramChannelLiveFactsInput['resolveParticipantsCount'],
): Promise<number | null> {
  if (resolver) {
    const resolved = await resolver(entity, normalizedChannelId);
    const normalizedResolved = normalizeNonNegativeInteger(resolved);
    if (normalizedResolved !== null) return normalizedResolved;
  }
  return normalizeNonNegativeInteger(entity['participantsCount']);
}

function extractDefaultBannedRights(input: unknown): DefaultBannedRightsSnapshot | null {
  if (!isRecord(input)) return null;
  return {
    sendMessages: input['sendMessages'] === true,
    sendPlain: input['sendPlain'] === true,
  };
}

function normalizeNonNegativeInteger(input: unknown): number | null {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return Math.floor(input);
  if (typeof input === 'string' && input.trim()) {
    const parsed = Number(input);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
}

function stringOrNull(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const value = String(input).trim();
  return value ? value : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object';
}

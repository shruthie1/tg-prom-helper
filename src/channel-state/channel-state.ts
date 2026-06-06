export const DEFAULT_CHANNEL_DOC_STALE_AFTER_DAYS = 30;
export const DEFAULT_CHANNEL_DOC_STALE_AFTER_MS: number = DEFAULT_CHANNEL_DOC_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

export type ChannelStateScope =
  | 'global'
  | 'account'
  | 'account_channel'
  | 'runtime'
  | 'reaction_cache'
  | 'none';

export type ChannelHydrationStatus =
  | 'fresh'
  | 'needs_hydration'
  | 'success'
  | 'transient_error'
  | 'permanent_error';

export interface DefaultBannedRightsSnapshot {
  sendMessages?: boolean | null;
  sendPlain?: boolean | null;
}

export interface TelegramChannelLiveFacts {
  channelId?: string | number | null;
  title?: string | null;
  username?: string | null;
  participantsCount?: number | null;
  broadcast?: boolean | null;
  restricted?: boolean | null;
  left?: boolean | null;
  private?: boolean | null;
  forbidden?: boolean | null;
  sendMessages?: boolean | null;
  sendPlain?: boolean | null;
  defaultBannedRights?: DefaultBannedRightsSnapshot | null;
  accessHash?: string | number | null;
  megagroup?: boolean | null;
}

export interface ChannelDocumentSnapshot extends TelegramChannelLiveFacts {
  canSendMsgs?: boolean | null;
  banned?: boolean | null;
  bannedAt?: Date | string | number | null;
  tempBan?: boolean | null;
  reactRestricted?: boolean | null;
  availableMsgs?: string[] | null;
  lastHydratedAt?: Date | string | number | null;
  lastLiveCheckedAt?: Date | string | number | null;
  updatedAt?: Date | string | number | null;
  lastHydrationStatus?: ChannelHydrationStatus | string | null;
  lastHydrationReason?: string | null;
  lastGlobalRestrictionReason?: string | null;
  lastGlobalRestrictionAt?: Date | string | number | null;
}

export interface ChannelStalePolicy {
  staleAfterMs?: number;
  now?: number;
  criticalFields?: readonly (keyof ChannelDocumentSnapshot)[];
}

export interface ChannelStalenessResult {
  stale: boolean;
  status: ChannelHydrationStatus;
  reason: string | null;
  ageMs: number | null;
  lastHydratedAt: number | null;
  missingFields: string[];
}

export interface ChannelSendabilityResult {
  canSend: boolean;
  reason: string | null;
  sendMessages: boolean;
  sendPlain: boolean;
}

export interface HydratedChannelMergeResult {
  patch: Partial<ChannelDocumentSnapshot>;
  canSendMsgs: boolean;
  clearedGlobalRestrictions: boolean;
}

export interface TelegramChannelErrorClassification {
  code: string;
  scope: ChannelStateScope;
  reason: string;
  waitSeconds: number | null;
  transient: boolean;
  shouldPersistGlobal: boolean;
  shouldPersistAccount: boolean;
  shouldClearReactionCache: boolean;
  shouldRestrictReactionChannel: boolean;
  shouldPausePromotionCycle: boolean;
}

export interface ChannelPromotionHealthInput extends ChannelDocumentSnapshot {
  successMsgCount?: number | null;
  failureMsgCount?: number | null;
  deletedCount?: number | null;
  followupMsgSuccessCount?: number | null;
  followupMsgFailureCount?: number | null;
  wordRestriction?: number | null;
  dMRestriction?: number | null;
  recentUniqueUsers?: number | null;
  lastUniqueUserCheckAt?: Date | string | number | null;
  lastMessageTime?: number | null;
  now?: number;
}

export interface ChannelPromotionHealthOptions {
  threshold?: number;
  probeCooldownDays?: number;
  probeMinSuccess?: number;
  activitySignalTtlDays?: number;
}

export interface ChannelPromotionHealthResult {
  promotable: boolean;
  reason: string;
  score: number;
  probeEligible: boolean;
  signals: {
    sendability: 'pass' | 'fail';
    banned: boolean;
    contentHealth: 'healthy' | 'degraded' | 'exhausted';
    deletionRate: 'low' | 'moderate' | 'severe';
    channelActivity: 'active' | 'low' | 'dead';
  };
}

export interface PromotionFailureActionInput {
  error: unknown;
  channelId?: string;
  now?: number;
}

export interface PromotionFailureAction {
  channelUpdate: Partial<{
    canSendMsgs: false;
    banned: true;
    bannedAt: number;
    private: true;
    forbidden: true;
    restricted: true;
  }> | null;
  skipPersist: boolean;
  code: string;
  reason: string;
  scope: ChannelStateScope;
}

export const DEFAULT_CHANNEL_HEALTH_THRESHOLD = 20;
export const DEFAULT_CHANNEL_PROBE_COOLDOWN_DAYS = 30;
export const DEFAULT_CHANNEL_PROBE_MIN_SUCCESS = 3;
export const DEFAULT_CHANNEL_ACTIVITY_SIGNAL_TTL_DAYS = 30;

const DEFAULT_CRITICAL_FIELDS: readonly (keyof ChannelDocumentSnapshot)[] = [
  'canSendMsgs',
  'sendMessages',
  'broadcast',
  'restricted',
  'private',
  'forbidden',
];

export function normalizeChannelId(input: unknown): string {
  if (input === null || input === undefined) return '';
  return String(input).trim().replace(/^-100/, '').replace(/^-/, '');
}

export function deriveTelegramChannelLiveFacts(entity: TelegramChannelLiveFacts): Required<Pick<TelegramChannelLiveFacts, 'broadcast' | 'restricted' | 'left' | 'private' | 'forbidden' | 'sendMessages' | 'sendPlain'>> & TelegramChannelLiveFacts {
  const sendMessages = entity.sendMessages === true || entity.defaultBannedRights?.sendMessages === true;
  const sendPlain = entity.sendPlain === true || entity.defaultBannedRights?.sendPlain === true;
  return {
    ...entity,
    channelId: normalizeChannelId(entity.channelId),
    broadcast: entity.broadcast === true,
    restricted: entity.restricted === true,
    left: entity.left === true,
    private: entity.private === true,
    forbidden: entity.forbidden === true,
    sendMessages,
    sendPlain,
  };
}

export function evaluateChannelSendability(input: TelegramChannelLiveFacts & { banned?: boolean | null; canSendMsgs?: boolean | null }): ChannelSendabilityResult {
  const facts = deriveTelegramChannelLiveFacts(input);
  if (!normalizeChannelId(facts.channelId)) return blocked('invalid_channel_id', facts);
  if (input.banned === true) return blocked('banned', facts);
  if (facts.private === true) return blocked('private', facts);
  if (facts.forbidden === true) return blocked('forbidden', facts);
  if (facts.broadcast === true) return blocked('broadcast', facts);
  if (facts.restricted === true) return blocked('restricted', facts);
  if (facts.left === true) return blocked('left', facts);
  if (facts.sendMessages === true) return blocked('sendMessages', facts);
  if (facts.sendPlain === true) return blocked('sendPlain', facts);
  if (input.canSendMsgs === false) return blocked('canSendMsgs_false', facts);
  return { canSend: true, reason: null, sendMessages: false, sendPlain: false };
}

export function computeLiveCanSendMsgs(input: TelegramChannelLiveFacts): boolean {
  const facts = deriveTelegramChannelLiveFacts(input);
  return !facts.broadcast
    && !facts.restricted
    && !facts.left
    && !facts.private
    && !facts.forbidden
    && !facts.sendMessages
    && !facts.sendPlain;
}

export function getChannelDocStaleness(doc: ChannelDocumentSnapshot | null | undefined, policy: ChannelStalePolicy = {}): ChannelStalenessResult {
  if (!doc) {
    return {
      stale: true,
      status: 'needs_hydration',
      reason: 'missing_doc',
      ageMs: null,
      lastHydratedAt: null,
      missingFields: [],
    };
  }

  const missingFields = getMissingCriticalFields(doc, policy.criticalFields ?? DEFAULT_CRITICAL_FIELDS);
  const lastHydratedAt = firstValidTimestamp(doc.lastHydratedAt, doc.lastLiveCheckedAt, doc.updatedAt);
  if (missingFields.length > 0) {
    return {
      stale: true,
      status: 'needs_hydration',
      reason: `missing_fields:${missingFields.join(',')}`,
      ageMs: lastHydratedAt ? Math.max(0, (policy.now ?? Date.now()) - lastHydratedAt) : null,
      lastHydratedAt,
      missingFields,
    };
  }

  if (!lastHydratedAt) {
    return {
      stale: true,
      status: 'needs_hydration',
      reason: 'missing_live_timestamp',
      ageMs: null,
      lastHydratedAt: null,
      missingFields,
    };
  }

  const now = policy.now ?? Date.now();
  const staleAfterMs = policy.staleAfterMs ?? DEFAULT_CHANNEL_DOC_STALE_AFTER_MS;
  const ageMs = Math.max(0, now - lastHydratedAt);
  if (ageMs >= staleAfterMs) {
    return {
      stale: true,
      status: 'needs_hydration',
      reason: 'older_than_30d',
      ageMs,
      lastHydratedAt,
      missingFields,
    };
  }

  return {
    stale: false,
    status: 'fresh',
    reason: null,
    ageMs,
    lastHydratedAt,
    missingFields,
  };
}

export function shouldHydrateBeforeFinalReject(doc: ChannelDocumentSnapshot | null | undefined, policy: ChannelStalePolicy = {}): boolean {
  const stale = getChannelDocStaleness(doc, policy);
  if (stale.stale) return true;
  return hasLegacyBlockingStateWithoutLiveHydration(doc);
}

export function mergeHydratedChannelFacts(
  existing: ChannelDocumentSnapshot | null | undefined,
  liveFactsInput: TelegramChannelLiveFacts,
  now: number = Date.now(),
): HydratedChannelMergeResult {
  const liveFacts = deriveTelegramChannelLiveFacts(liveFactsInput);
  const canSendMsgs = computeLiveCanSendMsgs(liveFacts);
  const banned = existing?.banned === true;
  const clearedGlobalRestrictions = !banned && (
    (existing?.private === true && liveFacts.private !== true)
    || (existing?.forbidden === true && liveFacts.forbidden !== true)
    || (existing?.restricted === true && liveFacts.restricted !== true)
    || (existing?.canSendMsgs === false && canSendMsgs)
  );
  const patch: Partial<ChannelDocumentSnapshot> = {
    channelId: normalizeChannelId(liveFacts.channelId),
    title: liveFacts.title ?? existing?.title ?? null,
    username: liveFacts.username ?? existing?.username ?? null,
    participantsCount: safeNumber(liveFacts.participantsCount, existing?.participantsCount ?? 0),
    broadcast: liveFacts.broadcast,
    restricted: liveFacts.restricted,
    private: canSendMsgs ? false : liveFacts.private,
    forbidden: canSendMsgs ? false : liveFacts.forbidden,
    sendMessages: liveFacts.sendMessages,
    sendPlain: liveFacts.sendPlain,
    canSendMsgs,
    megagroup: liveFacts.megagroup ?? existing?.megagroup ?? null,
    accessHash: liveFacts.accessHash ?? existing?.accessHash ?? null,
    banned,
    lastHydratedAt: now,
    lastLiveCheckedAt: now,
    lastHydrationStatus: 'success',
    lastHydrationReason: canSendMsgs ? 'live_sendable' : evaluateChannelSendability(liveFacts).reason,
  };
  return { patch, canSendMsgs, clearedGlobalRestrictions };
}

export function evaluateChannelPromotionHealth(
  input: ChannelPromotionHealthInput | null | undefined,
  options: ChannelPromotionHealthOptions = {},
): ChannelPromotionHealthResult {
  const channel = isRecord(input) ? input as ChannelPromotionHealthInput : {};
  const threshold = safePositiveNumber(options.threshold, DEFAULT_CHANNEL_HEALTH_THRESHOLD);
  const probeCooldownDays = safePositiveNumber(options.probeCooldownDays, DEFAULT_CHANNEL_PROBE_COOLDOWN_DAYS);
  const probeMinSuccess = safeNonNegativeNumber(options.probeMinSuccess, DEFAULT_CHANNEL_PROBE_MIN_SUCCESS);
  const activitySignalTtlDays = safePositiveNumber(options.activitySignalTtlDays, DEFAULT_CHANNEL_ACTIVITY_SIGNAL_TTL_DAYS);
  const now = safePositiveNumber(channel.now, Date.now());

  const sendability = evaluateChannelSendability({ ...channel, banned: false });
  const probeSendability = evaluateChannelSendability({ ...channel, banned: false, canSendMsgs: true });
  const sendabilityPass = sendability.canSend && channel.canSendMsgs === true;
  const banned = channel.banned === true;
  const successMsgCount = safeNonNegativeNumber(channel.successMsgCount);
  const failureMsgCount = safeNonNegativeNumber(channel.failureMsgCount);
  const followupMsgSuccessCount = safeNonNegativeNumber(channel.followupMsgSuccessCount);
  const followupMsgFailureCount = safeNonNegativeNumber(channel.followupMsgFailureCount);
  const deletedCount = safeNonNegativeNumber(channel.deletedCount);
  const wordRestriction = safeNonNegativeNumber(channel.wordRestriction);
  const dMRestriction = safeNonNegativeNumber(channel.dMRestriction);
  const participantsCount = safeNonNegativeNumber(channel.participantsCount);
  const recentUniqueUsers = safeNonNegativeNumber(channel.recentUniqueUsers);
  const contentHealth = classifyContentHealth(channel.availableMsgs);
  const deletionRate = classifyDeletionRate(deletedCount, successMsgCount + followupMsgSuccessCount);
  const channelActivity = classifyChannelActivity({
    participantsCount,
    recentUniqueUsers,
    lastUniqueUserCheckAt: channel.lastUniqueUserCheckAt,
    now,
    ttlDays: activitySignalTtlDays,
  });
  const signals = {
    sendability: (banned ? probeSendability.canSend : sendabilityPass) ? 'pass' as const : 'fail' as const,
    banned,
    contentHealth,
    deletionRate,
    channelActivity,
  };

  const probeEligible = banned
    && probeSendability.canSend
    && isProbeCooldownElapsed(channel.bannedAt, now, probeCooldownDays)
    && successMsgCount >= probeMinSuccess
    && deletionRate !== 'severe';

  if (!banned && !sendabilityPass) {
    return {
      promotable: false,
      reason: sendability.reason || 'canSendMsgs_missing',
      score: 0,
      probeEligible: false,
      signals,
    };
  }

  if (banned) {
    return {
      promotable: false,
      reason: probeEligible ? 'banned_probe_eligible' : probeSendability.reason || 'banned',
      score: 0,
      probeEligible,
      signals,
    };
  }

  const score = Math.max(0, Math.min(100, 100
    - contentPenalty(contentHealth)
    - deletionPenalty(deletionRate)
    - failurePenalty(successMsgCount + followupMsgSuccessCount, failureMsgCount + followupMsgFailureCount)
    - activityPenalty(channelActivity)
    - recentUniqueUserPenalty(recentUniqueUsers, channel.lastUniqueUserCheckAt, now, activitySignalTtlDays)
    - moderationPenalty(wordRestriction + dMRestriction)));

  const promotable = score > threshold;
  return {
    promotable,
    reason: promotable ? 'promotable' : `health_score_below_threshold:${score}`,
    score,
    probeEligible: false,
    signals,
  };
}

export function resolvePromotionFailureAction(input: PromotionFailureActionInput | unknown): PromotionFailureAction {
  let actionInput: PromotionFailureActionInput = { error: input };
  if (isRecord(input) && 'error' in input) {
    actionInput = { error: input['error'] };
    if (typeof input['channelId'] === 'string') {
      actionInput.channelId = input['channelId'];
    }
    if (typeof input['now'] === 'number') {
      actionInput.now = input['now'];
    }
  }
  const classified = classifyTelegramChannelError(actionInput.error);
  const now = safePositiveNumber(actionInput.now, Date.now());
  const base = {
    code: classified.code,
    reason: classified.reason,
    scope: classified.scope,
  };

  if (!classified.shouldPersistGlobal && !classified.shouldPersistAccount) {
    return { ...base, channelUpdate: null, skipPersist: true };
  }

  if (classified.code === 'USER_BANNED_IN_CHANNEL') {
    return {
      ...base,
      channelUpdate: { banned: true, bannedAt: now, canSendMsgs: false },
      skipPersist: false,
    };
  }

  if (classified.reason === 'private') {
    return { ...base, channelUpdate: { private: true, canSendMsgs: false }, skipPersist: false };
  }

  if (classified.reason === 'invalid') {
    return { ...base, channelUpdate: { forbidden: true, canSendMsgs: false }, skipPersist: false };
  }

  if (classified.code === 'CHAT_WRITE_FORBIDDEN' || classified.shouldPersistGlobal) {
    return { ...base, channelUpdate: { restricted: true, canSendMsgs: false }, skipPersist: false };
  }

  return { ...base, channelUpdate: null, skipPersist: false };
}

export function classifyTelegramChannelError(error: unknown): TelegramChannelErrorClassification {
  const message = errorToText(error).toUpperCase();
  const waitSeconds = parseWaitSeconds(message);

  if (message.includes('REACTION_INVALID')) {
    return classification('REACTION_INVALID', 'reaction_cache', 'reaction_invalid', null, false, false, false, true, false, false);
  }
  if (message.includes('FLOOD_WAIT') || waitSeconds !== null) {
    return classification('FLOOD_WAIT', 'account_channel', 'flood_wait', waitSeconds ?? 60, true, false, true, false, false, false);
  }
  if (message.includes('USER_BANNED_IN_CHANNEL') || message.includes('CHANNEL_RESTRICTED:BANNED')) {
    return classification('USER_BANNED_IN_CHANNEL', 'account_channel', 'user_banned_in_channel', null, false, false, true, false, false, false);
  }
  if (message.includes('ALLOW_PAYMENT_REQUIRED') || message.includes('PAYMENT_REQUIRED')) {
    return classification('ALLOW_PAYMENT_REQUIRED', 'account_channel', 'allow_payment_required', null, false, false, true, false, false, false);
  }
  if (message.includes('CHAT_WRITE_FORBIDDEN') || message.includes('CHANNEL_RESTRICTED:WRITE_FORBIDDEN')) {
    return classification('CHAT_WRITE_FORBIDDEN', 'global', 'write_forbidden', null, false, true, false, false, true, false);
  }
  if (message.includes('CHANNEL_PRIVATE') || message.includes('CHANNEL_RESTRICTED:PRIVATE')) {
    return classification('CHANNEL_PRIVATE', 'global', 'private', null, false, true, false, false, true, false);
  }
  if (message.includes('TELEGRAM ENTITY NOT FOUND') || message.includes('ENTITY NOT FOUND')) {
    return classification('CHANNEL_INVALID', 'global', 'invalid', null, false, true, false, false, true, false);
  }
  if (message.includes('CHANNEL_INVALID') || message.includes('CHAT_INVALID') || message.includes('USERNAME_INVALID') || message.includes('CHANNEL_RESTRICTED:INVALID')) {
    return classification('CHANNEL_INVALID', 'global', 'invalid', null, false, true, false, false, true, false);
  }
  if (message.includes('TOPIC_CLOSED') || message.includes('CHANNEL_RESTRICTED:TOPIC_CLOSED')) {
    return classification('TOPIC_CLOSED', 'runtime', 'topic_closed', null, true, false, false, false, false, false);
  }

  return classification('UNKNOWN', 'none', 'unknown', null, true, false, false, false, false, false);
}

function blocked(reason: string, facts: ReturnType<typeof deriveTelegramChannelLiveFacts>): ChannelSendabilityResult {
  return { canSend: false, reason, sendMessages: facts.sendMessages === true, sendPlain: facts.sendPlain === true };
}

function getMissingCriticalFields(doc: ChannelDocumentSnapshot, fields: readonly (keyof ChannelDocumentSnapshot)[]): string[] {
  return fields
    .filter((field) => doc[field] === undefined || doc[field] === null)
    .map((field) => String(field));
}

function hasLegacyBlockingStateWithoutLiveHydration(doc: ChannelDocumentSnapshot | null | undefined): boolean {
  if (!doc) return true;
  if (firstValidTimestamp(doc.lastHydratedAt, doc.lastLiveCheckedAt) !== null) return false;
  return doc.canSendMsgs === false
    || doc.banned === true
    || doc.private === true
    || doc.forbidden === true
    || doc.restricted === true
    || doc.broadcast === true
    || doc.sendMessages === true
    || doc.sendPlain === true;
}

function firstValidTimestamp(...values: unknown[]): number | null {
  for (const value of values) {
    const timestamp = toTimestamp(value);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeNonNegativeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (value instanceof Date) return safeNonNegativeNumber(value.getTime(), fallback);
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return fallback;
}

function safePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function classifyContentHealth(availableMsgs: unknown): ChannelPromotionHealthResult['signals']['contentHealth'] {
  if (!Array.isArray(availableMsgs)) return 'healthy';
  if (availableMsgs.length === 0) return 'exhausted';
  if (availableMsgs.length <= 5) return 'degraded';
  return 'healthy';
}

function classifyDeletionRate(deletedCount: number, survivingMessages: number): ChannelPromotionHealthResult['signals']['deletionRate'] {
  if (deletedCount >= 3 && survivingMessages <= 0) return 'severe';
  const totalMessages = deletedCount + survivingMessages;
  const deleteRate = totalMessages > 0 ? deletedCount / totalMessages : 0;
  if (deletedCount >= 5 && deleteRate >= 0.70) return 'severe';
  if (deletedCount >= 3 && deleteRate >= 0.40) return 'moderate';
  return 'low';
}

function classifyChannelActivity(input: {
  participantsCount: number;
  recentUniqueUsers: number;
  lastUniqueUserCheckAt: unknown;
  now: number;
  ttlDays: number;
}): ChannelPromotionHealthResult['signals']['channelActivity'] {
  if (isFreshActivitySignal(input.lastUniqueUserCheckAt, input.now, input.ttlDays)) {
    if (input.recentUniqueUsers < 8) return 'dead';
    if (input.recentUniqueUsers < 20) return 'low';
  }
  const participantsCount = input.participantsCount;
  if (participantsCount < 50) return 'dead';
  if (participantsCount < 200) return 'low';
  return 'active';
}

function contentPenalty(contentHealth: ChannelPromotionHealthResult['signals']['contentHealth']): number {
  if (contentHealth === 'exhausted') return 40;
  if (contentHealth === 'degraded') return 15;
  return 0;
}

function deletionPenalty(deletionRate: ChannelPromotionHealthResult['signals']['deletionRate']): number {
  if (deletionRate === 'severe') return 35;
  if (deletionRate === 'moderate') return 15;
  return 0;
}

function failurePenalty(successCount: number, failureCount: number): number {
  const totalAttempts = successCount + failureCount;
  if (totalAttempts < 3) return 0;
  const failureRate = failureCount / totalAttempts;
  if (failureRate >= 0.80) return 25;
  if (failureRate >= 0.50) return 10;
  return 0;
}

function activityPenalty(channelActivity: ChannelPromotionHealthResult['signals']['channelActivity']): number {
  if (channelActivity === 'dead') return 20;
  if (channelActivity === 'low') return 5;
  return 0;
}

function recentUniqueUserPenalty(
  recentUniqueUsers: number,
  lastUniqueUserCheckAt: unknown,
  now: number,
  ttlDays: number,
): number {
  if (!isFreshActivitySignal(lastUniqueUserCheckAt, now, ttlDays)) return 0;
  return recentUniqueUsers < 8 ? 60 : 0;
}

function moderationPenalty(totalRestrictionCount: number): number {
  if (totalRestrictionCount >= 8) return 15;
  if (totalRestrictionCount >= 4) return 5;
  return 0;
}

function isProbeCooldownElapsed(bannedAt: unknown, now: number, cooldownDays: number): boolean {
  const timestamp = toTimestamp(bannedAt);
  if (timestamp === null) return false;
  return now - timestamp > cooldownDays * 24 * 60 * 60 * 1000;
}

function isFreshActivitySignal(lastUniqueUserCheckAt: unknown, now: number, ttlDays: number): boolean {
  const timestamp = toTimestamp(lastUniqueUserCheckAt);
  if (timestamp === null) return false;
  return now - timestamp <= ttlDays * 24 * 60 * 60 * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorToText(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message, String((error as { errorMessage?: unknown }).errorMessage ?? '')].join(' ');
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    return [record['errorMessage'], record['message'], record['code']].filter(Boolean).join(' ');
  }
  return String(error ?? '');
}

function parseWaitSeconds(message: string): number | null {
  const match = message.match(/(?:FLOOD_WAIT|A WAIT OF)\D*(\d+)/);
  if (!match?.[1]) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function classification(
  code: string,
  scope: ChannelStateScope,
  reason: string,
  waitSeconds: number | null,
  transient: boolean,
  shouldPersistGlobal: boolean,
  shouldPersistAccount: boolean,
  shouldClearReactionCache: boolean,
  shouldRestrictReactionChannel: boolean,
  shouldPausePromotionCycle: boolean,
): TelegramChannelErrorClassification {
  return {
    code,
    scope,
    reason,
    waitSeconds,
    transient,
    shouldPersistGlobal,
    shouldPersistAccount,
    shouldClearReactionCache,
    shouldRestrictReactionChannel,
    shouldPausePromotionCycle,
  };
}

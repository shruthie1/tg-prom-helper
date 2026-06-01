const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const ALL_STRATEGIES = [
  'ai_contextual',
  'markov_chain',
  'natural_template',
  'question_doubt',
  'curiosity_gap',
  'legacy',
];

const EMPTY_ARM = { s: 0, f: 0, n: 0 };
const DEFAULT_MESSAGES = ['0', '1', '2', '3', '4'];

const args = parseArgs(process.argv.slice(2));
const write = args.write === true;
const limit = asPositiveInteger(args.limit, 0);
const batchSize = asPositiveInteger(args.batchSize || args['batch-size'], 500);
const sampleSize = asPositiveInteger(args.sample, 10);
const maxArmPulls = asPositiveInteger(args.maxArmPulls || args['max-arm-pulls'], 200);

const uri = resolveMongoUri();
if (!uri) {
  throw new Error('Set MONGODB_URI, mongodburi, or mongouri to run channel intelligence backfill');
}

const client = new MongoClient(uri, {
  maxPoolSize: 4,
  serverSelectionTimeoutMS: 10_000,
});

async function main() {
  await client.connect();
  const db = client.db('tgclients');
  const active = db.collection('activeChannels');
  const intelligence = db.collection('channelIntelligence');
  const existingIntelligence = new Map();
  const existingCursor = intelligence.find({});
  while (await existingCursor.hasNext()) {
    const doc = await existingCursor.next();
    const channelId = normalizeChannelId(doc && doc.channelId);
    if (channelId) existingIntelligence.set(channelId, doc);
  }

  const query = {
    banned: { $ne: true },
    forbidden: { $ne: true },
    restricted: { $ne: true },
    broadcast: { $ne: true },
    canSendMsgs: { $ne: false },
    $expr: {
      $gt: [
        {
          $add: [
            { $ifNull: ['$successMsgCount', 0] },
            { $ifNull: ['$failureMsgCount', 0] },
            { $ifNull: ['$deletedCount', 0] },
            { $ifNull: ['$followupMsgSuccessCount', 0] },
            { $ifNull: ['$followupMsgFailureCount', 0] },
          ],
        },
        0,
      ],
    },
  };

  const cursor = active.find(query, {
    projection: {
      _id: 0,
      channelId: 1,
      title: 1,
      username: 1,
      participantsCount: 1,
      successMsgCount: 1,
      failureMsgCount: 1,
      deletedCount: 1,
      followupMsgSuccessCount: 1,
      followupMsgFailureCount: 1,
      lastMessageTime: 1,
      updatedAt: 1,
      availableMsgs: 1,
    },
  }).sort({ successMsgCount: -1, failureMsgCount: -1 });
  if (limit > 0) cursor.limit(limit);

  const summary = {
    mode: write ? 'write' : 'dry-run',
    scanned: 0,
    plannedUpserts: 0,
    plannedExistingRepairs: 0,
    plannedNewDocs: 0,
    plannedMissingSchemaRepairs: 0,
    plannedLegacySeedUpdates: 0,
    skippedInvalidChannelId: 0,
    skippedNoHistory: 0,
    bulkWrites: 0,
    maxArmPulls,
    samples: [],
  };

  const pendingOps = [];

  while (await cursor.hasNext()) {
    const channel = await cursor.next();
    summary.scanned += 1;
    const channelId = normalizeChannelId(channel && channel.channelId);
    if (!channelId) {
      summary.skippedInvalidChannelId += 1;
      continue;
    }

    const counters = readCounters(channel);
    if (counters.historyTotal <= 0) {
      summary.skippedNoHistory += 1;
      continue;
    }

    const existing = existingIntelligence.get(channelId) || null;
    const planned = planIntelligenceUpdate(channelId, channel, counters, existing, maxArmPulls);
    if (!planned) continue;

    summary.plannedUpserts += 1;
    if (existing) summary.plannedExistingRepairs += 1;
    else summary.plannedNewDocs += 1;
    if (planned.missingSchemaRepaired) summary.plannedMissingSchemaRepairs += 1;
    if (planned.legacySeedUpdated) summary.plannedLegacySeedUpdates += 1;

    if (summary.samples.length < sampleSize) {
      summary.samples.push({
        channelId,
        title: channel.title,
        participantsCount: channel.participantsCount ?? null,
        existed: !!existing,
        historyTotal: counters.historyTotal,
        mainSuccess: counters.success,
        mainFailure: counters.failure,
        deleted: counters.deleted,
        followupSuccess: counters.followupSuccess,
        followupFailure: counters.followupFailure,
        legacyArm: planned.set['strategies.legacy'],
        expectedValue: planned.set.expectedValue,
        stage: planned.set.stage,
        totalSendsToChannel: planned.set.totalSendsToChannel,
        saturationRate: planned.set.saturationRate,
      });
    }

    if (write) {
      pendingOps.push({
        updateOne: {
          filter: { channelId },
          update: {
            $setOnInsert: planned.setOnInsert,
            $set: planned.set,
          },
          upsert: true,
        },
      });
      if (pendingOps.length >= batchSize) {
        await flush(intelligence, pendingOps, summary);
      }
    }
  }

  if (write) {
    await flush(intelligence, pendingOps, summary);
  }

  console.log(JSON.stringify(summary, null, 2));
}

function planIntelligenceUpdate(channelId, channel, counters, existing, maxPulls) {
  const now = Date.now();
  const nowDate = new Date();
  const title = normalizeText(channel.title) || 'general_chat';
  const category = classifyChannel(title, channel.username);
  const seededArm = seedLegacyArm(counters, maxPulls);
  const existingStrategies = normalizeStrategies(existing && existing.strategies);
  const legacyArm = mergeArm(existingStrategies.legacy, seededArm);
  const strategies = {
    ...existingStrategies,
    legacy: legacyArm,
  };

  const followupTotal = counters.followupSuccess + counters.followupFailure;
  const followupSuccessRate = followupTotal > 0 ? round3(counters.followupSuccess / followupTotal) : readRate(existing && existing.followupSuccessRate, 0.5);
  const totalSendsToChannel = Math.max(
    nonNegative(existing && existing.totalSendsToChannel),
    counters.success + counters.followupSuccess,
  );
  const participantsCount = nonNegative(channel.participantsCount);
  const saturationRate = participantsCount > 0 ? round3(totalSendsToChannel / participantsCount) : nonNegative(existing && existing.saturationRate);
  const deletionTiming = normalizeDeletionTiming(existing && existing.deletionTiming, counters.deleted);
  const errors = normalizeErrors(existing && existing.errors);
  const expectedValue = computeExpectedValue({
    strategies,
    followupSuccessRate,
    followupTotal,
    deletionTiming,
    errors,
    totalSendsToChannel,
    saturationRate,
    channelCategory: category.category,
  });
  const stage = chooseStage(existing && existing.stage, legacyArm.n, expectedValue, counters, errors);
  const scoreUpdatedAt = now;

  const setOnInsert = {
    channelId,
    firstSeenAt: validTimestamp(existing && existing.firstSeenAt, now),
  };
  const set = {
    topic: normalizeText(existing && existing.topic) || title,
    topicConfidence: validNumber(existing && existing.topicConfidence, 0),
    language: normalizeText(existing && existing.language) || 'unknown',
    languageConfidence: validNumber(existing && existing.languageConfidence, 0),
    profileUpdatedAt: validTimestamp(existing && existing.profileUpdatedAt, 0),
    strategies,
    followupSuccessRate,
    followupSuccessCount: Math.max(nonNegative(existing && existing.followupSuccessCount), counters.followupSuccess),
    followupTotal: Math.max(nonNegative(existing && existing.followupTotal), followupTotal),
    deletionTiming,
    onlineTrend: normalizeOnlineTrend(existing && existing.onlineTrend),
    viewEngagement: normalizeViewEngagement(existing && existing.viewEngagement),
    errors,
    lastPromotedAt: Math.max(validTimestamp(existing && existing.lastPromotedAt, 0), validTimestamp(channel.lastMessageTime, 0)),
    cooldownUntil: validTimestamp(existing && existing.cooldownUntil, 0),
    expectedValue,
    scoreUpdatedAt,
    totalSendsToChannel,
    saturationRate,
    conversions: validNumber(existing && existing.conversions, 0),
    paidConversions: validNumber(existing && existing.paidConversions, 0),
    conversionUpdatedAt: validTimestamp(existing && existing.conversionUpdatedAt, 0),
    channelCategory: normalizeCategory(existing && existing.channelCategory) || category.category,
    categoryConfidence: validNumber(existing && existing.categoryConfidence, category.confidence),
    categoryUpdatedAt: validTimestamp(existing && existing.categoryUpdatedAt, category.category === 'unclassified' ? 0 : now),
    promotionFitScore: validNumber(existing && existing.promotionFitScore, category.fit),
    stage,
    stageUpdatedAt: existing && existing.stage === stage ? validTimestamp(existing.stageUpdatedAt, now) : now,
    updatedAt: nowDate,
  };

  const missingSchemaRepaired = !existing ||
    existing.totalSendsToChannel === undefined ||
    existing.saturationRate === undefined ||
    existing.channelCategory === undefined ||
    existing.conversions === undefined ||
    existing.paidConversions === undefined;
  const legacySeedUpdated = !existing ||
    !existing.strategies ||
    !existing.strategies.legacy ||
    nonNegative(existing.strategies.legacy.n) < legacyArm.n;

  return { setOnInsert, set, missingSchemaRepaired, legacySeedUpdated };
}

function createDefaultIntelligence(channelId, topic, now, nowDate) {
  return {
    channelId,
    stage: 'new',
    stageUpdatedAt: now,
    firstSeenAt: now,
    topic,
    topicConfidence: 0,
    language: 'unknown',
    languageConfidence: 0,
    profileUpdatedAt: 0,
    strategies: createDefaultStrategies(),
    followupSuccessRate: 0.5,
    followupSuccessCount: 0,
    followupTotal: 0,
    deletionTiming: { automod: 0, bot: 0, human: 0, late: 0 },
    onlineTrend: { ewma: 0, lastSampled: 0, sampleCount: 0 },
    viewEngagement: { ewmaRatio: 0, lastChecked: 0, checksCount: 0 },
    errors: { consecutiveErrors: 0 },
    lastPromotedAt: 0,
    cooldownUntil: 0,
    expectedValue: 0.5,
    scoreUpdatedAt: now,
    totalSendsToChannel: 0,
    saturationRate: 0,
    conversions: 0,
    paidConversions: 0,
    conversionUpdatedAt: 0,
    channelCategory: 'unclassified',
    categoryConfidence: 0,
    categoryUpdatedAt: 0,
    promotionFitScore: 0.25,
    updatedAt: nowDate,
  };
}

async function flush(collection, ops, summary) {
  if (ops.length === 0) return;
  await collection.bulkWrite(ops.splice(0, ops.length), { ordered: false });
  summary.bulkWrites += 1;
}

function readCounters(channel) {
  const success = nonNegative(channel.successMsgCount);
  const failure = nonNegative(channel.failureMsgCount);
  const deleted = nonNegative(channel.deletedCount);
  const followupSuccess = nonNegative(channel.followupMsgSuccessCount);
  const followupFailure = nonNegative(channel.followupMsgFailureCount);
  return {
    success,
    failure,
    deleted,
    followupSuccess,
    followupFailure,
    historyTotal: success + failure + deleted + followupSuccess + followupFailure,
  };
}

function seedLegacyArm(counters, maxPulls) {
  const rawSuccess = counters.success + counters.followupSuccess;
  const rawFailure = counters.failure + counters.deleted + counters.followupFailure;
  const rawTotal = rawSuccess + rawFailure;
  if (rawTotal <= 0) return { ...EMPTY_ARM };
  const cappedTotal = Math.min(maxPulls, rawTotal);
  const successRate = rawSuccess / rawTotal;
  const s = round2(cappedTotal * successRate);
  const f = round2(cappedTotal - s);
  return { s, f, n: Math.round(cappedTotal) };
}

function mergeArm(existing, seeded) {
  const arm = normalizeArm(existing);
  return arm.n >= seeded.n ? arm : seeded;
}

function computeExpectedValue(doc) {
  const arms = Object.values(doc.strategies).map((arm) => {
    const s = nonNegative(arm.s);
    const f = nonNegative(arm.f);
    const total = s + f;
    return total === 0 ? 0.5 : s / total;
  });
  const bestArmEV = arms.length ? Math.max(...arms) : 0.5;
  const followupBonus = doc.followupTotal < 5 ? 0 : (doc.followupSuccessRate - 0.5) * 0.2;
  const totalDeletions = nonNegative(doc.deletionTiming.automod) + nonNegative(doc.deletionTiming.bot) +
    nonNegative(doc.deletionTiming.human) + nonNegative(doc.deletionTiming.late);
  const automodPenalty = totalDeletions === 0 ? 0 : (nonNegative(doc.deletionTiming.automod) / totalDeletions) * 0.3;
  const errorPenalty = Math.min(0.4, nonNegative(doc.errors.consecutiveErrors) * 0.08);
  const saturationPenalty = doc.saturationRate >= 10 ? 0.55
    : doc.saturationRate >= 5 ? 0.35
    : doc.saturationRate >= 3 ? 0.25
    : doc.saturationRate >= 1 ? 0.12
    : 0;
  const categoryBonus = doc.channelCategory === 'high_intent' ? 0.10
    : doc.channelCategory === 'social_chat' ? 0.03
    : doc.channelCategory === 'off_topic' ? -0.15
    : 0;
  const raw = bestArmEV + followupBonus + categoryBonus - automodPenalty - errorPenalty - saturationPenalty;
  const saturationCap = doc.saturationRate >= 10 ? 0.55
    : doc.saturationRate >= 5 ? 0.70
    : doc.saturationRate >= 3 ? 0.80
    : 0.99;
  return round3(Math.max(0.01, Math.min(saturationCap, raw)));
}

function chooseStage(existingStage, pulls, expectedValue, counters, errors) {
  const rawAttempts = counters.success + counters.failure + counters.deleted;
  const deleteRate = rawAttempts > 0 ? counters.deleted / rawAttempts : 0;
  const failRate = rawAttempts > 0 ? (counters.failure + counters.deleted) / rawAttempts : 0;
  if ((counters.deleted > 100 && deleteRate > 0.05) || (rawAttempts > 50 && failRate > 0.95) || nonNegative(errors.consecutiveErrors) > 5) {
    return 'hostile';
  }
  if (pulls >= 30 && expectedValue >= 0.65) return 'optimized';
  if (pulls >= 5) return 'learning';
  return normalizeStage(existingStage) || 'new';
}

function normalizeStrategies(value) {
  const source = isRecord(value) ? value : {};
  const strategies = createDefaultStrategies();
  for (const strategy of ALL_STRATEGIES) {
    strategies[strategy] = normalizeArm(source[strategy]);
  }
  return strategies;
}

function createDefaultStrategies() {
  return Object.fromEntries(ALL_STRATEGIES.map((strategy) => [strategy, { ...EMPTY_ARM }]));
}

function normalizeArm(value) {
  const source = isRecord(value) ? value : {};
  const s = nonNegative(source.s);
  const f = nonNegative(source.f);
  const n = Math.max(nonNegative(source.n), Math.round(s + f));
  return { s, f, n };
}

function normalizeDeletionTiming(value, deletedCount) {
  const source = isRecord(value) ? value : {};
  const existingTotal = nonNegative(source.automod) + nonNegative(source.bot) + nonNegative(source.human) + nonNegative(source.late);
  if (existingTotal >= deletedCount) {
    return {
      automod: nonNegative(source.automod),
      bot: nonNegative(source.bot),
      human: nonNegative(source.human),
      late: nonNegative(source.late),
    };
  }
  return {
    automod: deletedCount,
    bot: nonNegative(source.bot),
    human: nonNegative(source.human),
    late: nonNegative(source.late),
  };
}

function normalizeErrors(value) {
  const source = isRecord(value) ? value : {};
  const errors = { consecutiveErrors: nonNegative(source.consecutiveErrors) };
  for (const key of ['SLOWMODE_WAIT', 'PEER_FLOOD', 'FLOOD_WAIT', 'CHANNEL_RESTRICTED', 'TRANSIENT']) {
    if (source[key] !== undefined) errors[key] = nonNegative(source[key]);
  }
  if (typeof source.lastErrorType === 'string') errors.lastErrorType = source.lastErrorType;
  if (validTimestamp(source.lastErrorAt, 0) > 0) errors.lastErrorAt = validTimestamp(source.lastErrorAt, 0);
  return errors;
}

function normalizeOnlineTrend(value) {
  const source = isRecord(value) ? value : {};
  return {
    ewma: nonNegative(source.ewma),
    lastSampled: validTimestamp(source.lastSampled, 0),
    sampleCount: nonNegative(source.sampleCount),
  };
}

function normalizeViewEngagement(value) {
  const source = isRecord(value) ? value : {};
  return {
    ewmaRatio: validNumber(source.ewmaRatio, 0),
    lastChecked: validTimestamp(source.lastChecked, 0),
    checksCount: nonNegative(source.checksCount),
  };
}

function classifyChannel(title, username) {
  const text = `${title || ''} ${username || ''}`.toLowerCase();
  if (/(chat|dating|date|love|friend|girl|boy|wife|swap|relationship|single|tamil|gay|sex|вирт|знаком)/i.test(text)) {
    return { category: 'high_intent', confidence: 0.7, fit: 0.85 };
  }
  if (/(group|community|talk|social)/i.test(text)) {
    return { category: 'social_chat', confidence: 0.55, fit: 0.6 };
  }
  if (/(crypto|bitcoin|trading|job|exam|class|news|movie|gaming|casino|bet|study|course|call-центр)/i.test(text)) {
    return { category: 'off_topic', confidence: 0.65, fit: 0.2 };
  }
  return { category: 'unclassified', confidence: 0, fit: 0.25 };
}

function normalizeCategory(value) {
  return ['high_intent', 'social_chat', 'regional_social', 'off_topic', 'unclassified'].includes(value) ? value : null;
}

function normalizeStage(value) {
  return ['new', 'learning', 'optimized', 'hostile'].includes(value) ? value : null;
}

function normalizeChannelId(value) {
  if (value === null || value === undefined) return '';
  const normalized = String(value).trim().replace(/^-100/, '').replace(/^-/, '');
  return /^\d{4,}$/.test(normalized) ? normalized : '';
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function validNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function validTimestamp(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readRate(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseArgs(values) {
  const parsed = {};
  for (const arg of values) {
    if (arg === '--write') {
      parsed.write = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.write = false;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) parsed[toCamelCase(match[1])] = match[2];
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function resolveMongoUri() {
  const tgAutEnvPath = path.resolve(__dirname, '../..', 'tg-aut-local/.env');
  const commonTgEnvPath = path.resolve(__dirname, '../..', 'CommonTgService-local/.env');
  return process.env.MONGODB_URI ||
    process.env.mongodburi ||
    process.env.mongouri ||
    readEnvValue(tgAutEnvPath, 'mongodburi') ||
    readEnvValue(tgAutEnvPath, 'mongouri') ||
    readEnvValue(commonTgEnvPath, 'mongodburi') ||
    readEnvValue(commonTgEnvPath, 'mongouri');
}

function readEnvValue(filePath, key) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || match[1] !== key) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close().catch(() => undefined);
  });

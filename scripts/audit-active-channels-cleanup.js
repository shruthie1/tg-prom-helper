const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const args = parseArgs(process.argv.slice(2));
const writeSafe = args.writeSafe === true;
const sampleSize = asPositiveInteger(args.sample, 10);
const uri = resolveMongoUri();

if (!uri) {
  throw new Error('Set MONGODB_URI, mongodburi, or mongouri to run active channel cleanup audit');
}

const client = new MongoClient(uri, {
  maxPoolSize: 2,
  serverSelectionTimeoutMS: 10_000,
});

async function main() {
  await client.connect();
  const db = client.db('tgclients');
  const active = db.collection('activeChannels');

  const [
    summary,
    duplicateIds,
    missingSendabilitySamples,
    invalidAvailableMsgsSamples,
    exhaustedSamples,
    inconsistentSendabilitySamples,
    highRiskSamples,
  ] = await Promise.all([
    active.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          invalidChannelId: {
            $sum: {
              $cond: [
                { $not: [{ $regexMatch: { input: { $toString: '$channelId' }, regex: /^\d{4,}$/ } }] },
                1,
                0,
              ],
            },
          },
          missingCanSendMsgs: { $sum: { $cond: [{ $eq: [{ $type: '$canSendMsgs' }, 'missing'] }, 1, 0] } },
          missingSendMessages: { $sum: { $cond: [{ $eq: [{ $type: '$sendMessages' }, 'missing'] }, 1, 0] } },
          missingSendPlain: { $sum: { $cond: [{ $eq: [{ $type: '$sendPlain' }, 'missing'] }, 1, 0] } },
          missingRestricted: { $sum: { $cond: [{ $eq: [{ $type: '$restricted' }, 'missing'] }, 1, 0] } },
          missingBroadcast: { $sum: { $cond: [{ $eq: [{ $type: '$broadcast' }, 'missing'] }, 1, 0] } },
          missingParticipants: { $sum: { $cond: [{ $eq: [{ $type: '$participantsCount' }, 'missing'] }, 1, 0] } },
          nullParticipants: { $sum: { $cond: [{ $eq: ['$participantsCount', null] }, 1, 0] } },
          missingAvailableMsgs: { $sum: { $cond: [{ $not: [{ $isArray: '$availableMsgs' }] }, 1, 0] } },
          emptyAvailableMsgs: {
            $sum: {
              $cond: [{ $and: [{ $isArray: '$availableMsgs' }, { $eq: [{ $size: '$availableMsgs' }, 0] }] }, 1, 0],
            },
          },
          bannedButCanSend: { $sum: { $cond: [{ $and: [{ $eq: ['$banned', true] }, { $ne: ['$canSendMsgs', false] }] }, 1, 0] } },
          forbiddenButCanSend: { $sum: { $cond: [{ $and: [{ $eq: ['$forbidden', true] }, { $ne: ['$canSendMsgs', false] }] }, 1, 0] } },
          restrictedButCanSend: { $sum: { $cond: [{ $and: [{ $eq: ['$restricted', true] }, { $ne: ['$canSendMsgs', false] }] }, 1, 0] } },
          broadcastButCanSend: { $sum: { $cond: [{ $and: [{ $eq: ['$broadcast', true] }, { $ne: ['$canSendMsgs', false] }] }, 1, 0] } },
          highDeleted: { $sum: { $cond: [{ $gt: ['$deletedCount', 30] }, 1, 0] } },
          highFailureLowSuccess: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ['$failureMsgCount', 100] },
                    { $gt: ['$failureMsgCount', { $multiply: [{ $ifNull: ['$successMsgCount', 0] }, 2] }] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]).toArray(),
    active.aggregate([
      { $group: { _id: '$channelId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $limit: sampleSize },
    ]).toArray(),
    active.find(
      {
        $or: [
          { canSendMsgs: { $exists: false } },
          { sendMessages: { $exists: false } },
          { sendPlain: { $exists: false } },
          { restricted: { $exists: false } },
          { broadcast: { $exists: false } },
        ],
      },
      { projection: sampleProjection() },
    ).limit(sampleSize).toArray(),
    active.find(
      { availableMsgs: { $not: { $type: 'array' } } },
      { projection: sampleProjection() },
    ).limit(sampleSize).toArray(),
    active.find(
      { availableMsgs: { $type: 'array', $size: 0 } },
      { projection: sampleProjection() },
    ).limit(sampleSize).toArray(),
    active.find(
      {
        $or: [
          { banned: true, canSendMsgs: { $ne: false } },
          { forbidden: true, canSendMsgs: { $ne: false } },
          { restricted: true, canSendMsgs: { $ne: false } },
          { broadcast: true, canSendMsgs: { $ne: false } },
        ],
      },
      { projection: sampleProjection() },
    ).limit(sampleSize).toArray(),
    active.find(
      {
        $or: [
          { deletedCount: { $gt: 30 } },
          {
            $expr: {
              $and: [
                { $gt: [{ $ifNull: ['$failureMsgCount', 0] }, 100] },
                { $gt: [{ $ifNull: ['$failureMsgCount', 0] }, { $multiply: [{ $ifNull: ['$successMsgCount', 0] }, 2] }] },
              ],
            },
          },
        ],
      },
      { projection: sampleProjection() },
    ).sort({ deletedCount: -1, failureMsgCount: -1 }).limit(sampleSize).toArray(),
  ]);

  const safeWrites = {
    mode: writeSafe ? 'write-safe' : 'dry-run',
    invalidAvailableMsgsMatched: await active.countDocuments({ availableMsgs: { $not: { $type: 'array' } } }),
    emptyAvailableMsgsMatched: await active.countDocuments({ availableMsgs: { $type: 'array', $size: 0 } }),
    inconsistentSafetyMatched: await active.countDocuments({
      $or: [
        { banned: true },
        { forbidden: true },
        { restricted: true },
        { broadcast: true },
        { sendMessages: true },
        { sendPlain: true },
      ],
      canSendMsgs: { $ne: false },
    }),
    invalidAvailableMsgsModified: 0,
    emptyAvailableMsgsModified: 0,
    inconsistentSafetyModified: 0,
  };

  if (writeSafe) {
    const now = new Date();
    const invalidAvailableMsgsResult = await active.updateMany(
      { availableMsgs: { $not: { $type: 'array' } } },
      { $set: { availableMsgs: DEFAULT_MESSAGES, updatedAt: now } },
    );
    safeWrites.invalidAvailableMsgsModified = invalidAvailableMsgsResult.modifiedCount;

    const emptyAvailableMsgsResult = await active.updateMany(
      { availableMsgs: { $type: 'array', $size: 0 } },
      { $set: { banned: true, canSendMsgs: false, updatedAt: now } },
    );
    safeWrites.emptyAvailableMsgsModified = emptyAvailableMsgsResult.modifiedCount;

    const inconsistentSafetyResult = await active.updateMany(
      {
        $or: [
          { banned: true },
          { forbidden: true },
          { restricted: true },
          { broadcast: true },
          { sendMessages: true },
          { sendPlain: true },
        ],
        canSendMsgs: { $ne: false },
      },
      { $set: { canSendMsgs: false, updatedAt: now } },
    );
    safeWrites.inconsistentSafetyModified = inconsistentSafetyResult.modifiedCount;
  }

  console.log(JSON.stringify({
    mode: writeSafe ? 'write-safe' : 'dry-run',
    summary: summary[0] || null,
    safeWrites,
    duplicateIds,
    samples: {
      missingSendability: missingSendabilitySamples,
      invalidAvailableMsgs: invalidAvailableMsgsSamples,
      exhaustedAvailableMsgs: exhaustedSamples,
      inconsistentSendability: inconsistentSendabilitySamples,
      highRisk: highRiskSamples,
    },
    recommendedWriteOrder: [
      'Backfill channelIntelligence first.',
      'Refresh missing Telegram sendability fields through normal DialogManager fetches.',
      'Only then apply conservative activeChannels fixes: normalize invalid availableMsgs and set canSendMsgs=false for banned/forbidden/restricted/broadcast inconsistencies.',
      'Do not delete activeChannels history; keep counters as training data.',
    ],
  }, null, 2));
}

function sampleProjection() {
  return {
    _id: 0,
    channelId: 1,
    title: 1,
    participantsCount: 1,
    canSendMsgs: 1,
    sendMessages: 1,
    sendPlain: 1,
    banned: 1,
    forbidden: 1,
    restricted: 1,
    broadcast: 1,
    availableMsgs: 1,
    successMsgCount: 1,
    failureMsgCount: 1,
    deletedCount: 1,
    updatedAt: 1,
  };
}

const DEFAULT_MESSAGES = ['0', '1', '2', '3', '4'];

function parseArgs(values) {
  const parsed = {};
  for (const arg of values) {
    if (arg === '--write-safe') {
      parsed.writeSafe = true;
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

function asPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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

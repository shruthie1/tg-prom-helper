const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

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

const tgAutEnvPath = path.resolve(__dirname, '../..', 'tg-aut-local/.env');
const commonTgEnvPath = path.resolve(__dirname, '../..', 'CommonTgService-local/.env');
const uri = process.env.MONGODB_URI ||
  process.env.mongodburi ||
  process.env.mongouri ||
  readEnvValue(tgAutEnvPath, 'mongodburi') ||
  readEnvValue(tgAutEnvPath, 'mongouri') ||
  readEnvValue(commonTgEnvPath, 'mongodburi') ||
  readEnvValue(commonTgEnvPath, 'mongouri');
if (!uri) {
  throw new Error('Set MONGODB_URI to run promotion collection analytics');
}

const client = new MongoClient(uri, {
  maxPoolSize: 2,
  serverSelectionTimeoutMS: 10_000,
});

const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

async function estimatedCount(db, name) {
  try {
    return await db.collection(name).estimatedDocumentCount();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  await client.connect();
  const db = client.db('tgclients');
  const active = db.collection('activeChannels');
  const intelligence = db.collection('channelIntelligence');

  const collectionCounts = {};
  for (const name of ['activeChannels', 'channelIntelligence', 'promoteStats', 'clients', 'userData', 'stats', 'stats2']) {
    collectionCounts[name] = await estimatedCount(db, name);
  }

  const [activeSummary] = await active.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        canSendTrue: { $sum: { $cond: [{ $eq: ['$canSendMsgs', true] }, 1, 0] } },
        canSendFalse: { $sum: { $cond: [{ $eq: ['$canSendMsgs', false] }, 1, 0] } },
        canSendMissing: { $sum: { $cond: [{ $eq: [{ $type: '$canSendMsgs' }, 'missing'] }, 1, 0] } },
        bannedTrue: { $sum: { $cond: [{ $eq: ['$banned', true] }, 1, 0] } },
        forbiddenTrue: { $sum: { $cond: [{ $eq: ['$forbidden', true] }, 1, 0] } },
        restrictedTrue: { $sum: { $cond: [{ $eq: ['$restricted', true] }, 1, 0] } },
        broadcastTrue: { $sum: { $cond: [{ $eq: ['$broadcast', true] }, 1, 0] } },
        noAvailableMsgs: {
          $sum: { $cond: [{ $and: [{ $isArray: '$availableMsgs' }, { $eq: [{ $size: '$availableMsgs' }, 0] }] }, 1, 0] },
        },
        missingAvailableMsgs: { $sum: { $cond: [{ $not: [{ $isArray: '$availableMsgs' }] }, 1, 0] } },
        withSuccess: { $sum: { $cond: [{ $gt: ['$successMsgCount', 0] }, 1, 0] } },
        withFailure: { $sum: { $cond: [{ $gt: ['$failureMsgCount', 0] }, 1, 0] } },
        withDeleted: { $sum: { $cond: [{ $gt: ['$deletedCount', 0] }, 1, 0] } },
        totalSuccess: { $sum: { $ifNull: ['$successMsgCount', 0] } },
        totalFailure: { $sum: { $ifNull: ['$failureMsgCount', 0] } },
        totalDeleted: { $sum: { $ifNull: ['$deletedCount', 0] } },
        totalFollowupSuccess: { $sum: { $ifNull: ['$followupMsgSuccessCount', 0] } },
        totalFollowupFailure: { $sum: { $ifNull: ['$followupMsgFailureCount', 0] } },
        avgParticipants: { $avg: '$participantsCount' },
        maxParticipants: { $max: '$participantsCount' },
        updatedRecently7d: { $sum: { $cond: [{ $gte: ['$updatedAt', weekAgo] }, 1, 0] } },
      },
    },
  ]).toArray();

  const [activePromotableSummary] = await active.aggregate([
    {
      $match: {
        banned: { $ne: true },
        forbidden: { $ne: true },
        restricted: { $ne: true },
        broadcast: { $ne: true },
        canSendMsgs: { $ne: false },
        participantsCount: { $gte: 500 },
        deletedCount: { $not: { $gt: 30 } },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        withHistory: {
          $sum: {
            $cond: [
              { $gt: [{ $add: [{ $ifNull: ['$successMsgCount', 0] }, { $ifNull: ['$failureMsgCount', 0] }, { $ifNull: ['$deletedCount', 0] }] }, 0] },
              1,
              0,
            ],
          },
        },
        totalSuccess: { $sum: { $ifNull: ['$successMsgCount', 0] } },
        totalFailure: { $sum: { $ifNull: ['$failureMsgCount', 0] } },
        totalDeleted: { $sum: { $ifNull: ['$deletedCount', 0] } },
        avgParticipants: { $avg: '$participantsCount' },
      },
    },
  ]).toArray();

  const [intelligenceSummary] = await intelligence.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        withSends: { $sum: { $cond: [{ $gt: ['$totalSendsToChannel', 0] }, 1, 0] } },
        withConversions: { $sum: { $cond: [{ $gt: ['$conversions', 0] }, 1, 0] } },
        withPaidConversions: { $sum: { $cond: [{ $gt: ['$paidConversions', 0] }, 1, 0] } },
        totalSends: { $sum: { $ifNull: ['$totalSendsToChannel', 0] } },
        totalConversions: { $sum: { $ifNull: ['$conversions', 0] } },
        totalPaidConversions: { $sum: { $ifNull: ['$paidConversions', 0] } },
        avgExpectedValue: { $avg: '$expectedValue' },
        maxExpectedValue: { $max: '$expectedValue' },
        updatedRecently7d: { $sum: { $cond: [{ $gte: ['$updatedAt', weekAgo] }, 1, 0] } },
      },
    },
  ]).toArray();

  const stageDist = await intelligence.aggregate([
    { $group: { _id: '$stage', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  const categoryDist = await intelligence.aggregate([
    { $group: { _id: '$channelCategory', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  const [overlap] = await active.aggregate([
    { $lookup: { from: 'channelIntelligence', localField: 'channelId', foreignField: 'channelId', as: 'intel' } },
    {
      $group: {
        _id: null,
        activeTotal: { $sum: 1 },
        activeWithIntel: { $sum: { $cond: [{ $gt: [{ $size: '$intel' }, 0] }, 1, 0] } },
        activeWithoutIntel: { $sum: { $cond: [{ $eq: [{ $size: '$intel' }, 0] }, 1, 0] } },
        historicalWithoutIntel: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $size: '$intel' }, 0] },
                  { $gt: [{ $add: [{ $ifNull: ['$successMsgCount', 0] }, { $ifNull: ['$failureMsgCount', 0] }, { $ifNull: ['$deletedCount', 0] }] }, 0] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]).toArray();

  const migrationCandidates = await active.aggregate([
    { $lookup: { from: 'channelIntelligence', localField: 'channelId', foreignField: 'channelId', as: 'intel' } },
    {
      $match: {
        intel: { $size: 0 },
        banned: { $ne: true },
        forbidden: { $ne: true },
        restricted: { $ne: true },
        broadcast: { $ne: true },
        canSendMsgs: { $ne: false },
      },
    },
    {
      $project: {
        _id: 0,
        channelId: 1,
        title: 1,
        participantsCount: 1,
        successMsgCount: { $ifNull: ['$successMsgCount', 0] },
        failureMsgCount: { $ifNull: ['$failureMsgCount', 0] },
        deletedCount: { $ifNull: ['$deletedCount', 0] },
        followupMsgSuccessCount: { $ifNull: ['$followupMsgSuccessCount', 0] },
        followupMsgFailureCount: { $ifNull: ['$followupMsgFailureCount', 0] },
        updatedAt: 1,
      },
    },
    {
      $addFields: {
        historyTotal: { $add: ['$successMsgCount', '$failureMsgCount', '$deletedCount', '$followupMsgSuccessCount', '$followupMsgFailureCount'] },
      },
    },
    { $sort: { historyTotal: -1, participantsCount: -1 } },
    { $limit: 10 },
  ]).toArray();

  const topActiveHistory = await active.aggregate([
    {
      $project: {
        _id: 0,
        channelId: 1,
        title: 1,
        participantsCount: 1,
        banned: 1,
        forbidden: 1,
        restricted: 1,
        canSendMsgs: 1,
        successMsgCount: { $ifNull: ['$successMsgCount', 0] },
        failureMsgCount: { $ifNull: ['$failureMsgCount', 0] },
        deletedCount: { $ifNull: ['$deletedCount', 0] },
      },
    },
    { $addFields: { historyTotal: { $add: ['$successMsgCount', '$failureMsgCount', '$deletedCount'] } } },
    { $match: { historyTotal: { $gt: 0 } } },
    { $sort: { historyTotal: -1 } },
    { $limit: 10 },
  ]).toArray();

  const sampleIntel = await intelligence
    .find({}, {
      projection: {
        _id: 0,
        channelId: 1,
        stage: 1,
        expectedValue: 1,
        totalSendsToChannel: 1,
        conversions: 1,
        paidConversions: 1,
        channelCategory: 1,
        updatedAt: 1,
      },
    })
    .sort({ updatedAt: -1 })
    .limit(5)
    .toArray();

  const [intelligenceShape] = await intelligence.aggregate([
    {
      $group: {
        _id: null,
        missingStrategies: { $sum: { $cond: [{ $eq: [{ $type: '$strategies' }, 'missing'] }, 1, 0] } },
        missingTotalSends: { $sum: { $cond: [{ $eq: [{ $type: '$totalSendsToChannel' }, 'missing'] }, 1, 0] } },
        missingSaturation: { $sum: { $cond: [{ $eq: [{ $type: '$saturationRate' }, 'missing'] }, 1, 0] } },
        missingChannelCategory: { $sum: { $cond: [{ $eq: [{ $type: '$channelCategory' }, 'missing'] }, 1, 0] } },
        missingConversions: { $sum: { $cond: [{ $eq: [{ $type: '$conversions' }, 'missing'] }, 1, 0] } },
        missingPaidConversions: { $sum: { $cond: [{ $eq: [{ $type: '$paidConversions' }, 'missing'] }, 1, 0] } },
        missingUpdatedAt: { $sum: { $cond: [{ $eq: [{ $type: '$updatedAt' }, 'missing'] }, 1, 0] } },
        docsWithAnyStrategyPulls: {
          $sum: {
            $cond: [
              {
                $gt: [
                  {
                    $add: [
                      { $ifNull: ['$strategies.ai_contextual.n', 0] },
                      { $ifNull: ['$strategies.markov_chain.n', 0] },
                      { $ifNull: ['$strategies.natural_template.n', 0] },
                      { $ifNull: ['$strategies.question_doubt.n', 0] },
                      { $ifNull: ['$strategies.curiosity_gap.n', 0] },
                      { $ifNull: ['$strategies.legacy.n', 0] },
                    ],
                  },
                  0,
                ],
              },
              1,
              0,
            ],
          },
        },
        totalStrategyPulls: {
          $sum: {
            $add: [
              { $ifNull: ['$strategies.ai_contextual.n', 0] },
              { $ifNull: ['$strategies.markov_chain.n', 0] },
              { $ifNull: ['$strategies.natural_template.n', 0] },
              { $ifNull: ['$strategies.question_doubt.n', 0] },
              { $ifNull: ['$strategies.curiosity_gap.n', 0] },
              { $ifNull: ['$strategies.legacy.n', 0] },
            ],
          },
        },
      },
    },
  ]).toArray();

  const [historyOverlap] = await active.aggregate([
    {
      $project: {
        channelId: 1,
        historyTotal: {
          $add: [
            { $ifNull: ['$successMsgCount', 0] },
            { $ifNull: ['$failureMsgCount', 0] },
            { $ifNull: ['$deletedCount', 0] },
            { $ifNull: ['$followupMsgSuccessCount', 0] },
            { $ifNull: ['$followupMsgFailureCount', 0] },
          ],
        },
      },
    },
    { $match: { historyTotal: { $gt: 0 } } },
    { $lookup: { from: 'channelIntelligence', localField: 'channelId', foreignField: 'channelId', as: 'intel' } },
    {
      $group: {
        _id: null,
        activeWithHistory: { $sum: 1 },
        historyWithIntel: { $sum: { $cond: [{ $gt: [{ $size: '$intel' }, 0] }, 1, 0] } },
        historyWithoutIntel: { $sum: { $cond: [{ $eq: [{ $size: '$intel' }, 0] }, 1, 0] } },
      },
    },
  ]).toArray();

  console.log(JSON.stringify({
    collectionCounts,
    activeSummary: activeSummary || null,
    activePromotableSummary: activePromotableSummary || null,
    intelligenceSummary: intelligenceSummary || null,
    stageDist,
    categoryDist,
    overlap: overlap || null,
    migrationCandidates,
    topActiveHistory,
    sampleIntel,
    intelligenceShape: intelligenceShape || null,
    historyOverlap: historyOverlap || null,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close().catch(() => undefined);
  });

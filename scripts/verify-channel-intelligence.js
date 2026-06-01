const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const uri = resolveMongoUri();
if (!uri) throw new Error('Set MONGODB_URI, mongodburi, or mongouri to verify channel intelligence');

const client = new MongoClient(uri, {
  maxPoolSize: 2,
  serverSelectionTimeoutMS: 10_000,
});

async function main() {
  await client.connect();
  const db = client.db('tgclients');
  const active = db.collection('activeChannels');
  const intelligence = db.collection('channelIntelligence');
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const counts = {
    activeChannels: await active.estimatedDocumentCount(),
    channelIntelligence: await intelligence.estimatedDocumentCount(),
  };

  const [summary] = await intelligence.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        withSends: { $sum: { $cond: [{ $gt: ['$totalSendsToChannel', 0] }, 1, 0] } },
        missingTotalSends: { $sum: { $cond: [{ $eq: [{ $type: '$totalSendsToChannel' }, 'missing'] }, 1, 0] } },
        missingSaturation: { $sum: { $cond: [{ $eq: [{ $type: '$saturationRate' }, 'missing'] }, 1, 0] } },
        missingCategory: { $sum: { $cond: [{ $eq: [{ $type: '$channelCategory' }, 'missing'] }, 1, 0] } },
        missingConversions: { $sum: { $cond: [{ $eq: [{ $type: '$conversions' }, 'missing'] }, 1, 0] } },
        updatedRecently7d: { $sum: { $cond: [{ $gte: ['$updatedAt', weekAgo] }, 1, 0] } },
        avgExpectedValue: { $avg: '$expectedValue' },
        totalSends: { $sum: { $ifNull: ['$totalSendsToChannel', 0] } },
      },
    },
  ]).toArray();

  const stages = await intelligence.aggregate([
    { $group: { _id: '$stage', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  const categories = await intelligence.aggregate([
    { $group: { _id: '$channelCategory', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  console.log(JSON.stringify({ counts, summary, stages, categories }, null, 2));
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

const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const write = process.argv.includes('--write');
const uri = resolveMongoUri();
if (!uri) throw new Error('Set MONGODB_URI, mongodburi, or mongouri to repair channel intelligence schema');

const client = new MongoClient(uri, {
  maxPoolSize: 2,
  serverSelectionTimeoutMS: 10_000,
});

async function main() {
  await client.connect();
  const intelligence = client.db('tgclients').collection('channelIntelligence');
  const filter = {
    $or: [
      { totalSendsToChannel: { $exists: false } },
      { saturationRate: { $exists: false } },
      { channelCategory: { $exists: false } },
      { conversions: { $exists: false } },
      { paidConversions: { $exists: false } },
      { conversionUpdatedAt: { $exists: false } },
      { promotionFitScore: { $exists: false } },
      { categoryConfidence: { $exists: false } },
      { categoryUpdatedAt: { $exists: false } },
    ],
  };

  const matched = await intelligence.countDocuments(filter);
  const summary = {
    mode: write ? 'write' : 'dry-run',
    matched,
    modified: 0,
  };

  if (write && matched > 0) {
    const result = await intelligence.updateMany(
      filter,
      [
        {
          $set: {
            totalSendsToChannel: { $ifNull: ['$totalSendsToChannel', 0] },
            saturationRate: { $ifNull: ['$saturationRate', 0] },
            conversions: { $ifNull: ['$conversions', 0] },
            paidConversions: { $ifNull: ['$paidConversions', 0] },
            conversionUpdatedAt: { $ifNull: ['$conversionUpdatedAt', 0] },
            channelCategory: { $ifNull: ['$channelCategory', 'unclassified'] },
            categoryConfidence: { $ifNull: ['$categoryConfidence', 0] },
            categoryUpdatedAt: { $ifNull: ['$categoryUpdatedAt', 0] },
            promotionFitScore: { $ifNull: ['$promotionFitScore', 0.25] },
            updatedAt: new Date(),
          },
        },
      ],
    );
    summary.modified = result.modifiedCount;
  }

  console.log(JSON.stringify(summary, null, 2));
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

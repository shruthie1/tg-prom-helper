import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Collection, Db } from 'mongodb';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type { ChannelIntelligenceDocument } from '../src';

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

export async function setupMongo(): Promise<{
  db: Db;
  client: MongoClient;
  activeChannels: Collection;
  intelligence: Collection<ChannelIntelligenceDocument>;
}> {
  mongod = await MongoMemoryServer.create({
    instance: {
      ip: '127.0.0.1',
    },
  });
  const uri = mongod.getUri();
  client = new MongoClient(uri);
  await client.connect();
  db = client.db('testdb');

  return {
    db,
    client,
    activeChannels: db.collection('activeChannels'),
    intelligence: db.collection<ChannelIntelligenceDocument>('channelIntelligence'),
  };
}

export async function teardownMongo(): Promise<void> {
  if (client) await client.close();
  if (mongod) await mongod.stop();
}

export function createRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

/**
 * Seed activeChannels with realistic promotion data.
 * Creates channels with varying success rates, participants, deletions, etc.
 */
export async function seedActiveChannels(
  collection: Collection,
  count: number = 100,
): Promise<void> {
  const docs = [];
  for (let i = 0; i < count; i++) {
    const successMsgCount = Math.floor(Math.random() * 500);
    const failureMsgCount = Math.floor(Math.random() * 100);
    const deletedCount = Math.floor(Math.random() * Math.max(1, successMsgCount * 0.3));
    const participantsCount = Math.floor(200 + Math.random() * 50000);
    const followupMsgSuccessCount = Math.floor(Math.random() * Math.max(1, successMsgCount * 0.5));

    docs.push({
      channelId: `ch_${i.toString().padStart(4, '0')}`,
      title: `Test Channel ${i}`,
      username: `testchannel${i}`,
      participantsCount,
      successMsgCount,
      failureMsgCount,
      deletedCount,
      followupMsgSuccessCount,
      banned: i % 50 === 0, // 2% banned
      forbidden: i % 70 === 0, // ~1.4% forbidden
      restricted: false,
      broadcast: false,
      sendMessages: false,
      canSendMsgs: true,
    });
  }
  await collection.insertMany(docs);
}

/**
 * Create a specific activeChannel with controlled values.
 */
export async function insertActiveChannel(
  collection: Collection,
  overrides: Partial<Record<string, unknown>> & { channelId: string },
): Promise<void> {
  await collection.insertOne({
    title: 'Test Channel',
    username: 'test',
    participantsCount: 1000,
    successMsgCount: 0,
    failureMsgCount: 0,
    deletedCount: 0,
    followupMsgSuccessCount: 0,
    banned: false,
    forbidden: false,
    restricted: false,
    broadcast: false,
    sendMessages: false,
    canSendMsgs: true,
    ...overrides,
  });
}

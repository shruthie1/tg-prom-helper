export type MongoSortSpec = Record<string, 1 | -1>;
export type MongoFindOptions = { projection?: Record<string, 1> };
export type MongoUpdateOptions = { upsert?: boolean; returnDocument?: 'after' | 'before' };
export type MongoCreateIndexOptions = { unique?: boolean; name?: string; sparse?: boolean };

export interface CursorLike<T> {
  sort(sort: MongoSortSpec): CursorLike<T>;
  limit(limit: number): CursorLike<T>;
  toArray(): Promise<T[]>;
}

export interface AggregateCursorLike<T> {
  toArray(): Promise<T[]>;
}

export interface MongoCollectionLike<T> {
  findOne(filter: object): Promise<T | null>;
  find(filter: object, options?: MongoFindOptions): CursorLike<T>;
  findOneAndUpdate(filter: object, update: object, options?: MongoUpdateOptions): Promise<T | null>;
  updateOne(filter: object, update: object, options?: MongoUpdateOptions): Promise<unknown>;
  updateMany?(filter: object, update: object, options?: MongoUpdateOptions): Promise<{ modifiedCount: number }>;
  createIndex(indexSpec: MongoSortSpec, options?: MongoCreateIndexOptions): Promise<unknown>;
}

export interface AggregateableCollectionLike {
  aggregate(pipeline: object[]): AggregateCursorLike<Record<string, unknown>>;
}

export interface RedisPipelineLike {
  lpush(key: string, value: string): RedisPipelineLike;
  ltrim(key: string, start: number, stop: number): RedisPipelineLike;
  expire(key: string, seconds: number): RedisPipelineLike;
  set(key: string, value: string, mode: 'EX', seconds: number): RedisPipelineLike;
  exec(): Promise<unknown>;
}

export type RedisExistsResult = number | string | boolean;

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  exists(key: string): Promise<RedisExistsResult>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  pipeline(): RedisPipelineLike;
}

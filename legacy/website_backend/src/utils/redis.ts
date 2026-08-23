import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL 未配置，已拒绝启动。");
}

class MemoryRedisMock {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  private hashStore = new Map<string, Map<string, string>>(); // 用于 hincrby/hgetall
  private hllStore = new Map<string, Set<string>>(); // 用于 HyperLogLog (pfadd/pfcount)
  private zsetStore = new Map<string, Map<string, number>>(); // 用于有序集合 (zadd/zincrby/zrevrange)

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, ...args: (string | number)[]) {
    // 支持 SET key value EX seconds NX 格式
    let ttlSeconds: number | null = null;
    let onlyIfNotExists = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "EX" && i + 1 < args.length) {
        ttlSeconds = Number(args[i + 1]);
        i++;
      } else if (arg === "NX") {
        onlyIfNotExists = true;
      }
    }

    // NX: 只在 key 不存在时设置
    if (onlyIfNotExists) {
      const existing = await this.get(key);
      if (existing !== null) {
        return null; // key 已存在，返回 null 表示未设置
      }
    }

    if (ttlSeconds !== null) {
      this.store.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    } else {
      this.store.set(key, { value });
    }
    return "OK";
  }

  async setex(key: string, seconds: number, value: string) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + seconds * 1000,
    });
    return "OK";
  }

  async del(...keys: string[]) {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      if (this.hashStore.delete(key)) count++;
      if (this.hllStore.delete(key)) count++;
      if (this.zsetStore.delete(key)) count++;
    }
    return count;
  }

  // ===== MGET（批量取字符串值） =====
  async mget(...keys: string[]): Promise<(string | null)[]> {
    const values: (string | null)[] = [];
    for (const key of keys) {
      values.push(await this.get(key));
    }
    return values;
  }

  // ===== 有序集合（Sorted Set）操作 =====
  async zadd(key: string, score: number, member: string): Promise<number> {
    let zset = this.zsetStore.get(key);
    if (!zset) {
      zset = new Map();
      this.zsetStore.set(key, zset);
    }
    const isNew = !zset.has(member);
    zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zincrby(key: string, increment: number, member: string): Promise<number> {
    let zset = this.zsetStore.get(key);
    if (!zset) {
      zset = new Map();
      this.zsetStore.set(key, zset);
    }
    const current = zset.get(member) || 0;
    const newScore = current + increment;
    zset.set(member, newScore);
    return newScore;
  }

  /**
   * 按分数降序返回成员（可带 WITHSCORES，返回 [member, score, member, score, ...]）。
   * 同分时按成员逆字典序排列（与 Redis 默认规则近似）。
   */
  async zrevrange(
    key: string,
    start: number,
    stop: number,
    withScores?: string
  ): Promise<string[]> {
    const zset = this.zsetStore.get(key);
    if (!zset) return [];

    const entries = Array.from(zset.entries());
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));

    const slice = entries.slice(start, stop === -1 ? undefined : stop + 1);
    const out: string[] = [];
    for (const [member, score] of slice) {
      out.push(member);
      if (withScores === "WITHSCORES") out.push(String(score));
    }
    return out;
  }

  async eval(_script: string, _numKeys: number, ..._args: (string | number)[]) {
    // Mock 实现：简单返回 0 表示失败
    return 0;
  }

  // ===== Hash 操作 =====
  async hincrby(key: string, field: string, increment: number): Promise<number> {
    let hash = this.hashStore.get(key);
    if (!hash) {
      hash = new Map();
      this.hashStore.set(key, hash);
    }
    const current = parseInt(hash.get(field) || "0", 10);
    const newValue = current + increment;
    hash.set(field, String(newValue));
    return newValue;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashStore.get(key);
    if (!hash) {
      return {};
    }
    const result: Record<string, string> = {};
    hash.forEach((value, field) => {
      result[field] = value;
    });
    return result;
  }

  // ===== HyperLogLog 操作 =====
  async pfadd(key: string, ...elements: string[]): Promise<number> {
    let hll = this.hllStore.get(key);
    if (!hll) {
      hll = new Set();
      this.hllStore.set(key, hll);
    }
    const beforeSize = hll.size;
    elements.forEach(el => hll!.add(el));
    return hll.size > beforeSize ? 1 : 0;
  }

  async pfcount(key: string): Promise<number> {
    const hll = this.hllStore.get(key);
    return hll ? hll.size : 0;
  }

  // ===== 过期时间操作 =====
  async expire(key: string, seconds: number): Promise<number> {
    // 检查 hashStore
    const hash = this.hashStore.get(key);
    if (hash) {
      // Mock: 不实际设置过期，只返回成功
      return 1;
    }
    // 检查 hllStore
    const hll = this.hllStore.get(key);
    if (hll) {
      return 1;
    }
    // 检查普通 store
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }
    return 0;
  }

  // ===== Pipeline 支持 =====
  pipeline(): MemoryRedisPipeline {
    return new MemoryRedisPipeline(this);
  }

  on(_event: string, callback: (...args: any[]) => void) {
    if (_event === "connect") {
      callback();
    }
  }
}

// Pipeline 类用于批量执行命令
class MemoryRedisPipeline {
  private redis: MemoryRedisMock;
  private commands: Array<() => Promise<any>> = [];

  constructor(redis: MemoryRedisMock) {
    this.redis = redis;
  }

  hincrby(key: string, field: string, increment: number): this {
    this.commands.push(() => this.redis.hincrby(key, field, increment));
    return this;
  }

  hincrbyfloat(key: string, field: string, increment: number): this {
    this.commands.push(() => this.redis.hincrby(key, field, increment));
    return this;
  }

  pfadd(key: string, element: string): this {
    this.commands.push(() => this.redis.pfadd(key, element));
    return this;
  }

  expire(key: string, seconds: number): this {
    this.commands.push(() => this.redis.expire(key, seconds));
    return this;
  }

  async exec(): Promise<any[]> {
    const results: any[] = [];
    for (const cmd of this.commands) {
      try {
        const result = await cmd();
        results.push([null, result]);
      } catch (err) {
        results.push([err, null]);
      }
    }
    this.commands = [];
    return results;
  }
}

const shouldUseMockRedis = process.env.NODE_ENV !== "production" && process.env.REDIS_MOCK_MODE === "true";

const redis = shouldUseMockRedis
  ? new MemoryRedisMock()
  : new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

redis.on("error", (err) => {
  console.error("Redis 连接错误:", err);
});

redis.on("connect", () => {
  console.log(shouldUseMockRedis ? "✓ Redis Mock 已启用" : "✓ Redis 连接成功");
});

export default redis;

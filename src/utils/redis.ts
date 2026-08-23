/**
 * Redis 连接（与网关共用实例）
 *
 * 配置方式二选一：
 *   A. REDIS_URL 连接串（优先，沿用旧约定）：redis://[:password@]host:port[/db]
 *   B. 分字段（适合要单独输密码/库号）：
 *        REDIS_HOST=localhost   REDIS_PORT=6379
 *        REDIS_PASSWORD=xxx     REDIS_DB=0
 *
 * 命名约定：拼车业务 key 统一加 `pt:` 前缀（pt:auth:code:{phone} 等），
 * 与网关 key（如 user_balance:{userId}）隔离。本实例不带 keyPrefix，
 * 需要清网关缓存时直接以原名操作。
 */

import Redis from "ioredis";
import type { RedisOptions } from "ioredis";

const redisUrl = process.env.REDIS_URL;

function buildConnectionConfig(): {
  url: string | null;
  opts: RedisOptions;
} {
  // 有 REDIS_URL 时整体使用 URL（其自带 host/port/password/db）
  if (redisUrl) {
    return { url: redisUrl, opts: {} };
  }

  // 否则按分字段组装；host 缺失且无 URL → 拒绝启动
  const host = process.env.REDIS_HOST;
  if (!host) {
    throw new Error("Redis 未配置：请设置 REDIS_URL，或 REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_DB。");
  }

  const opts: RedisOptions = {
    host,
    port: Number(process.env.REDIS_PORT) || 6379,
  };

  const password = process.env.REDIS_PASSWORD;
  if (password) {
    opts.password = password;
  }

  const db = process.env.REDIS_DB;
  if (db !== undefined && db !== "") {
    opts.db = Number(db);
  }

  return { url: null, opts };
}

const { url, opts } = buildConnectionConfig();

const baseOpts = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
};

const redis = url
  ? new Redis(url, baseOpts)
  : new Redis({ ...baseOpts, ...opts });

redis.on("error", (err) => {
  console.error("Redis 连接错误:", err);
});

redis.on("connect", () => {
  console.log("✓ Redis 连接成功");
});

export default redis;

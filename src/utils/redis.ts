/**
 * Redis 连接（与网关共用实例）
 *
 * 命名约定：拼车业务 key 统一加 `pt:` 前缀（pt:auth:code:{phone} 等），
 * 与网关 key（如 user_balance:{userId}）隔离。本实例不带 keyPrefix，
 * 需要清网关缓存时直接以原名操作。
 */

import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL 未配置，已拒绝启动。");
}

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

redis.on("error", (err) => {
  console.error("Redis 连接错误:", err);
});

redis.on("connect", () => {
  console.log("✓ Redis 连接成功");
});

export default redis;

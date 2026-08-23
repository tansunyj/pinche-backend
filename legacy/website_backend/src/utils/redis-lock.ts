/**
 * Redis 分布式锁
 *
 * 使用 Redis SET key value EX seconds NX 实现互斥锁
 * 支持自动续期（看门狗）和防误删（唯一 token）
 */

import redis from "./redis";

const DEFAULT_LOCK_TIMEOUT_MS = 30_000; // 默认锁超时 30 秒
const LOCK_PREFIX = "lock:";

interface LockOptions {
  /** 锁超时时间（毫秒），默认 30000 */
  timeoutMs?: number;
  /** 重试次数，默认 0（不重试） */
  retryCount?: number;
  /** 重试间隔（毫秒），默认 100 */
  retryDelayMs?: number;
}

interface Lock {
  /** 锁的唯一标识 */
  token: string;
  /** 释放锁 */
  unlock: () => Promise<void>;
  /** 续期（看门狗） */
  extend: (additionalMs: number) => Promise<boolean>;
}

/**
 * 获取分布式锁
 *
 * @param resourceId 资源标识（如：media_job:123）
 * @param options 锁选项
 * @returns Lock 对象或 null（获取失败）
 */
export async function acquireLock(
  resourceId: string,
  options: LockOptions = {}
): Promise<Lock | null> {
  const {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    retryCount = 0,
    retryDelayMs = 100,
  } = options;

  const key = `${LOCK_PREFIX}${resourceId}`;
  // 使用实例标识 + 时间戳 + 随机数生成唯一 token
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ttlSeconds = Math.ceil(timeoutMs / 1000);

  const tryLock = async (): Promise<boolean> => {
    // NX: 只在 key 不存在时设置，EX: 设置过期时间（秒）
    const result = await redis.set(key, token, "EX", ttlSeconds, "NX");
    return result === "OK";
  };

  // 首次尝试
  if (await tryLock()) {
    return createLock(key, token, timeoutMs);
  }

  // 重试逻辑
  for (let i = 0; i < retryCount; i++) {
    await sleep(retryDelayMs);
    if (await tryLock()) {
      return createLock(key, token, timeoutMs);
    }
  }

  return null;
}

/**
 * 尝试获取锁，如果获取失败立即返回 null（不阻塞）
 */
export async function tryLock(resourceId: string, timeoutMs?: number): Promise<Lock | null> {
  return acquireLock(resourceId, { timeoutMs, retryCount: 0 });
}

/**
 * 带锁执行函数（自动获取和释放锁）
 *
 * @param resourceId 资源标识
 * @param fn 要执行的函数
 * @param options 锁选项
 * @returns 函数执行结果或 null（获取锁失败）
 */
export async function withLock<T>(
  resourceId: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T | null> {
  const lock = await acquireLock(resourceId, options);
  if (!lock) {
    return null;
  }

  try {
    return await fn();
  } finally {
    await lock.unlock();
  }
}

/**
 * 批量获取多个锁（全部获取成功才返回，否则释放已获取的锁）
 *
 * @param resourceIds 资源标识列表
 * @param options 锁选项
 * @returns Lock[] 或 null（任一锁获取失败）
 */
export async function acquireMultiLock(
  resourceIds: string[],
  options: LockOptions = {}
): Promise<{ locks: Lock[]; unlockAll: () => Promise<void> } | null> {
  const locks: Lock[] = [];

  for (const id of resourceIds) {
    const lock = await acquireLock(id, { ...options, retryCount: 0 });
    if (!lock) {
      // 获取失败，释放已获取的锁
      await Promise.all(locks.map((l) => l.unlock()));
      return null;
    }
    locks.push(lock);
  }

  const unlockAll = async () => {
    await Promise.all(locks.map((l) => l.unlock()));
  };

  return { locks, unlockAll };
}

function createLock(key: string, token: string, timeoutMs: number): Lock {
  let isReleased = false;

  const unlock = async (): Promise<void> => {
    if (isReleased) return;
    isReleased = true;

    try {
      // 使用 Lua 脚本确保原子性：只有 token 匹配时才删除
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redis.eval(luaScript, 1, key, token);
    } catch (err) {
      console.error(`[RedisLock] 释放锁失败 ${key}:`, err);
    }
  };

  const extend = async (additionalMs: number): Promise<boolean> => {
    if (isReleased) return false;

    try {
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;
      const additionalSeconds = Math.ceil(additionalMs / 1000);
      const result = await redis.eval(luaScript, 1, key, token, String(additionalSeconds));
      return result === 1;
    } catch (err) {
      console.error(`[RedisLock] 续期失败 ${key}:`, err);
      return false;
    }
  };

  // 自动续期（看门狗）：在锁即将过期前自动续期
  // 注意：这里使用简化的看门狗，实际生产环境可能需要更复杂的逻辑
  const watchDogInterval = Math.max(5000, timeoutMs / 3);
  const watchDog = setInterval(async () => {
    if (isReleased) {
      clearInterval(watchDog);
      return;
    }

    const extended = await extend(timeoutMs);
    if (!extended) {
      console.warn(`[RedisLock] 看门狗续期失败 ${key}，锁可能已被其他实例获取`);
      clearInterval(watchDog);
    }
  }, watchDogInterval);

  // 包装 unlock 方法，确保清除看门狗
  const originalUnlock = unlock;
  unlock.unlock = async (): Promise<void> => {
    clearInterval(watchDog);
    await originalUnlock();
  };

  return { token, unlock, extend };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  acquireLock,
  tryLock,
  withLock,
  acquireMultiLock,
};

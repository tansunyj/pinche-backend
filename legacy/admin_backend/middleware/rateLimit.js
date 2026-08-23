/**
 * 通用限流 / 失败计数中间件工厂
 *
 * 设计要点：
 *  - 基于内存 Map，单进程足够用；多进程/多机部署请改 Redis 实现。
 *  - 不在每次请求时计数，而是由业务代码主动调用 recordFailure()。
 *    这样能区分"恶意尝试"和"正常请求"，避免误伤真实用户。
 *  - 任意时刻达到阈值 → 进入封禁窗口；封禁期内 middleware 直接 429。
 *
 * 用法：
 *   const limiter = createLimiter({
 *     name: 'login',
 *     windowMs: 15 * 60 * 1000,
 *     max: 10,
 *     blockMs: 30 * 60 * 1000,
 *     message: '失败次数过多，请稍后再试',
 *   });
 *
 *   router.post('/login', limiter.middleware, async (req, res) => {
 *     // ... 登录逻辑
 *     if (loginFailed) {
 *       const entry = limiter.recordFailure(req);
 *       return res.status(401).json({
 *         error: '用户名或密码错误',
 *         attemptsLeft: Math.max(0, limiter.max - entry.count),
 *       });
 *     }
 *     limiter.clear(req); // 登录成功清零
 *   });
 */

const stores = new Map();

function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || req.socket?.remoteAddress
    || ''
  ).toString();
}

/**
 * @param {Object} opts
 * @param {string} opts.name           - 唯一名字，便于调试
 * @param {number} opts.windowMs       - 计数窗口（毫秒）
 * @param {number} opts.max            - 窗口内允许的最大失败次数
 * @param {number} [opts.blockMs]      - 触发后封禁时长（默认等于 windowMs）
 * @param {string} [opts.message]      - 触发时返回的提示
 * @param {(req)=>string} [opts.keyGenerator] - 生成 key（默认按客户端 IP）
 */
function createLimiter({
  name,
  windowMs,
  max,
  blockMs,
  message,
  keyGenerator,
  recordOnEnter = false,
}) {
  if (!name || !windowMs || !max) {
    throw new Error('createLimiter 缺少必要参数: name / windowMs / max');
  }
  const finalBlockMs = blockMs ?? windowMs;
  const store = new Map(); // key -> { count, firstAt, blockedUntil }
  stores.set(name, store);

  const getKey = (req) => (keyGenerator ? keyGenerator(req) : getClientIp(req)) || 'unknown';

  const middleware = (req, res, next) => {
    const key = getKey(req);
    const entry = store.get(key);
    const now = Date.now();
    if (entry?.blockedUntil && entry.blockedUntil > now) {
      const retry = Math.ceil((entry.blockedUntil - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({
        error: message || `请求过于频繁，请 ${retry} 秒后再试`,
        retryAfter: retry,
      });
    }
    if (recordOnEnter) {
      // 频次限流：每次进入都计数；达到 max 时设置 blockedUntil，下一次请求即被拒
      recordFailure(req);
    }
    next();
  };

  function recordFailure(req) {
    const key = getKey(req);
    const now = Date.now();
    let entry = store.get(key);
    if (!entry || now - entry.firstAt > windowMs) {
      entry = { count: 0, firstAt: now, blockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= max) {
      entry.blockedUntil = now + finalBlockMs;
    }
    store.set(key, entry);
    return entry;
  }

  function clear(req) {
    store.delete(getKey(req));
  }

  function status(req) {
    return store.get(getKey(req)) || null;
  }

  return { middleware, recordFailure, clear, status, store, max, name };
}

// 周期性清理已过期 entry，避免内存无限增长
const CLEANUP_INTERVAL = 10 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  for (const store of stores.values()) {
    for (const [k, v] of store.entries()) {
      const expired = (!v.blockedUntil || v.blockedUntil < now) && now - v.firstAt > oneDay;
      if (expired) store.delete(k);
    }
  }
}, CLEANUP_INTERVAL);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

module.exports = { createLimiter, getClientIp };

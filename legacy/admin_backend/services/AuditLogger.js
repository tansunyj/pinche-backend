/**
 * 管理员操作审计日志
 *
 * 表：admin_audit_logs（DDL 见 server/db/migrations/002_upgrade_to_v1.0.sql）
 * 字段：admin_id, action, target_type, target_id, before_value(JSON),
 *       after_value(JSON), reason, ip, user_agent, created_at
 *
 * 用法：
 *   const audit = require('../services/AuditLogger');
 *
 *   // 方式 1：在路由中直接调用（最直观）
 *   await audit.log(req, {
 *     action: 'channel.update',
 *     targetType: 'channel',
 *     targetId: id,
 *     before, after,
 *   });
 *
 *   // 方式 2：挂载 router 级中间件，路由通过 req.audit = {...} 声明
 *   //         由 finalize 中间件统一在响应成功后异步入库
 *   router.use(audit.attachAutoFlush());
 *   router.post('/', async (req, res) => {
 *     const r = await query('INSERT ...');
 *     req.audit = { action: 'channel.create', targetType: 'channel',
 *                   targetId: r.insertId, after: req.body };
 *     res.json({ success: true, id: r.insertId });
 *   });
 */

const { query } = require('../db/init');

const SENSITIVE_KEYS = new Set([
  'password', 'pwd', 'old_password', 'new_password',
  'api_key', 'apiKey', 'api_key_encrypted',
  'token', 'access_token', 'refresh_token', 'secret',
  'authorization',
]);

/**
 * 递归脱敏：把敏感字段值替换成 '***'
 */
function sanitize(obj, depth = 0) {
  if (obj == null || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map(v => sanitize(v, depth + 1));
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = v == null || v === '' ? v : '***';
    } else {
      out[k] = sanitize(v, depth + 1);
    }
  }
  return out;
}

/**
 * 取客户端 IP（兼容反向代理）
 *
 * 注意：本函数会在 res.on('finish') 之后通过 setImmediate 异步执行，
 * 那时 req.socket 可能已经处于 keep-alive 等待新请求的状态。所以
 * attachAutoFlush 中间件会在请求一进来就把 IP 缓存到 req._auditClientIp，
 * 这里优先用缓存值。
 */
function clientIp(req) {
  if (req._auditClientIp) return req._auditClientIp;

  const xff = req.headers?.['x-forwarded-for'];
  let ip = '';
  if (xff) {
    ip = String(xff).split(',')[0].trim();
  } else {
    ip = req.ip
      || req.socket?.remoteAddress
      || req.connection?.remoteAddress
      || '';
  }
  // 把 IPv4-mapped IPv6 (::ffff:127.0.0.1) 还原成 127.0.0.1
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // 把纯 IPv6 loopback 也归一
  if (ip === '::1') ip = '127.0.0.1';
  return ip.slice(0, 45);
}

/**
 * 写一条审计日志（异步、错误吞掉，不影响主流程）
 */
async function log(req, fields) {
  try {
    const adminId = req?.user?.id;
    if (!adminId) return;

    const {
      action,
      targetType = null,
      targetId = null,
      before = null,
      after = null,
      reason = null,
    } = fields || {};

    if (!action) return;

    await query(
      `INSERT INTO admin_audit_logs
        (admin_id, action, target_type, target_id, before_value, after_value,
         reason, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adminId,
        String(action).slice(0, 80),
        targetType ? String(targetType).slice(0, 40) : null,
        targetId != null ? String(targetId).slice(0, 64) : null,
        before != null ? JSON.stringify(sanitize(before)) : null,
        after != null ? JSON.stringify(sanitize(after)) : null,
        reason ? String(reason).slice(0, 200) : null,
        clientIp(req),
        (req.headers?.['user-agent'] || '').toString().slice(0, 500),
      ]
    );
  } catch (e) {
    // 审计失败不影响业务，仅打印
    console.error('[AuditLogger] write failed:', e.message);
  }
}

/**
 * 中间件：监听 res 'finish'，若 2xx 且 req.audit 已被路由设置，则异步落库
 *
 * 把这个中间件挂在 admin router 链路上：
 *   app.use('/api/admin/channels', audit.attachAutoFlush(), channelRoutes);
 */
/**
 * 从 method + originalUrl 推导出一个兜底的 action / targetType
 * 仅在路由未显式设置 req.audit 时使用
 */
function deriveFallbackAudit(req) {
  const method = (req.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;

  // 把 /api/admin/marketplace/models/qwen-plus/prices/12 这种路径切成段
  const url = (req.originalUrl || req.url || '').split('?')[0];
  const parts = url.split('/').filter(Boolean);
  // 去掉 api/admin 前缀
  while (parts.length && (parts[0] === 'api' || parts[0] === 'admin')) parts.shift();

  // 提取资源类型（路径里非纯数字/uuid 的段）
  const resourceSegs = parts.filter(p => !/^[0-9]+$/.test(p));
  const targetType = resourceSegs.slice(0, 2).join('.') || 'unknown';

  const verb = method === 'POST' ? 'create'
    : method === 'PUT' || method === 'PATCH' ? 'update'
    : 'delete';

  return {
    action: `${targetType}.${verb}`,
    targetType: resourceSegs[0] || 'unknown',
    targetId: parts[parts.length - 1] || null,
    // 写操作兜底保留请求体（会经过 sanitize 脱敏）
    after: req.body && Object.keys(req.body).length ? req.body : null,
  };
}

function attachAutoFlush() {
  return function auditAutoFlushMiddleware(req, res, next) {
    // 在请求刚进来时就把 IP 抓住，避免 finish 后 socket 已不可读
    req._auditClientIp = clientIp(req);

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const payload = req.audit || deriveFallbackAudit(req);
      if (!payload) return;
      // setImmediate 让出主循环，绝不阻塞响应
      setImmediate(() => log(req, payload));
    });
    next();
  };
}

module.exports = {
  log,
  attachAutoFlush,
  sanitize,
};

/**
 * 用户/管理员业务操作审计
 *
 * 表：user_audit_log（MySQL 表结构）
 *
 * 用法（推荐：在路由处理函数中显式赋 req.audit）：
 *   import { audit, attachAuditAutoFlush } from '../utils/audit';
 *
 *   // 1) 给某个 router 链路挂自动落库
 *   router.use(attachAuditAutoFlush({ category: 'user' }));
 *
 *   // 2) 路由内声明本次操作
 *   router.post('/orders', authMiddleware, async (req, res) => {
 *     req.audit = {
 *       action: 'order.create',
 *       targetType: 'order',
 *       targetId: order.id,
 *       after: order,
 *     };
 *     res.json({ success: true, data: order });
 *   });
 *
 * 也可以直接调用 audit.log(req, {...}) 立即写入。
 */

import type { Request, Response, NextFunction } from 'express';
import pool from '../db/mysql';

const SENSITIVE_KEYS = new Set([
  'password', 'oldpassword', 'newpassword',
  'apikey', 'api_key', 'token', 'access_token', 'refresh_token',
  'secret', 'authorization', 'cookie', 'set-cookie',
  'emailverifytokenhash', 'passwordresettokenhash', 'refreshtokenhash',
  'apikeyhash', 'claimcodehash',
]);

function sanitize<T>(value: T, depth = 0): T {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1)) as any;
  if (typeof value !== 'object') return value;
  const out: any = {};
  for (const [k, v] of Object.entries(value as any)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = v == null || v === '' ? v : '***';
    } else {
      out[k] = sanitize(v, depth + 1);
    }
  }
  return out;
}

function safeStringify(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(sanitize(value));
  } catch {
    return null;
  }
}

function clientIp(req: Request): string | null {
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim().slice(0, 64);
  return (req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null;
}

export interface AuditPayload {
  action: string;
  category?: 'user' | 'admin' | 'agent' | 'system';
  targetType?: string | null;
  targetId?: string | null;
  targetUserId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      audit?: AuditPayload;
    }
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
}

export const audit = {
  /**
   * 立即落库一条审计；失败仅打印不抛
   */
  async log(req: Request, payload: AuditPayload): Promise<void> {
    if (!payload?.action) return;
    try {
      const actorId = req.user?.userId != null ? String(req.user.userId) : null;
      const userType = req.user?.userType;
      const actorRole = userType === 3 ? 'superadmin'
        : userType === 2 ? 'admin'
        : userType === 1 ? 'user'
        : null;

      await pool.execute(
        'INSERT INTO user_audit_log (\n' +
        '  id, actorId, actorRole, action, category,\n' +
        '  targetType, targetId, targetUserId,\n' +
        '  `before`, `after`, reason,\n' +
        '  ip, userAgent, requestPath, httpMethod, statusCode, createdAt\n' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
        [
          generateId(),
          actorId,
          actorRole,
          String(payload.action).slice(0, 120),
          payload.category ?? (actorRole === 'admin' || actorRole === 'superadmin' ? 'admin'
            : actorRole === 'user' ? 'user' : 'system'),
          payload.targetType ? String(payload.targetType).slice(0, 60) : null,
          payload.targetId ? String(payload.targetId).slice(0, 80) : null,
          payload.targetUserId ? String(payload.targetUserId).slice(0, 80) : null,
          safeStringify(payload.before),
          safeStringify(payload.after),
          payload.reason ? String(payload.reason).slice(0, 500) : null,
          clientIp(req),
          (req.headers?.['user-agent'] || '').toString().slice(0, 500) || null,
          (req.originalUrl || req.url || '').slice(0, 500) || null,
          (req.method || '').slice(0, 10) || null,
          null,
        ]
      );
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[audit] write failed:', err?.message || err);
    }
  },
};

/**
 * 由 method+url 推断兜底 action
 * 仅在路由没有显式 req.audit 时启用
 */
function deriveFallback(req: Request): AuditPayload | null {
  const method = (req.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;

  const url = (req.originalUrl || req.url || '').split('?')[0];
  const parts = url.split('/').filter(Boolean);
  while (parts.length && parts[0] === 'api') parts.shift();

  const resourceSegs = parts.filter(p => !/^[0-9]+$/.test(p) && !/^c[a-z0-9]{20,}$/i.test(p));
  const targetType = resourceSegs[0] || 'unknown';
  const verb = method === 'POST' ? 'create'
    : method === 'PUT' || method === 'PATCH' ? 'update'
    : 'delete';

  return {
    action: `${targetType}.${verb}`,
    targetType,
    targetId: parts[parts.length - 1] || null,
    after: req.body && Object.keys(req.body).length ? req.body : null,
  };
}

/**
 * 自动落库中间件：res.finish 时若状态 2xx 则按 req.audit 落库；
 * 若 req.audit 未声明，但是写操作（POST/PUT/PATCH/DELETE），生成兜底 action。
 *
 * options.category 用于强制覆盖（如挂在 admin 路由链路上时设为 'admin'）
 */
export function attachAuditAutoFlush(options: { category?: AuditPayload['category'] } = {}) {
  return function auditAutoFlushMiddleware(req: Request, res: Response, next: NextFunction) {
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const payload = req.audit || deriveFallback(req);
      if (!payload) return;
      if (options.category) payload.category = options.category;
      setImmediate(() => audit.log(req, payload));
    });
    next();
  };
}

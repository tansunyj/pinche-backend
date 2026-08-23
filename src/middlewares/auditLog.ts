/**
 * 全接口操作审计中间件
 *
 * 记录每个 HTTP 请求（请求+响应、IP、User-Agent、操作者、耗时）到 pt_audit_logs：
 *   - actor 识别：req.admin?.username（管理端，adminAuth 注入）→ admin
 *                 req.user?.phone / req.user?.userId（用户端，userAuth 注入）→ user
 *                 无身份 → system
 *   - 脱敏：递归替换 password/secret/token/key/authorization/credential 等键值为 [REDACTED]
 *   - 截断：request_body / response_body 各截 4000 字符
 *   - 排除：/api/health、OPTIONS（CORS 预检）——避免噪音
 *   - 写入：res 'finish' 后 fire-and-forget（不阻塞响应，失败仅 console.error）
 *
 * 必须挂载在 express.json 之后（才能读到 body）、业务路由之前。
 */

import { Request, Response, NextFunction } from "express";
import { cpQuery } from "../config/db";
import logger from "../utils/logger";
import { verifyRefreshToken, verifyToken } from "../utils/jwt";

const BODY_TRUNCATE = 4000;
const UA_TRUNCATE = 500;
const QUERY_TRUNCATE = 1000;
const PATH_TRUNCATE = 500;

/** 敏感键名（命中即脱敏） */
const SENSITIVE_KEY = /password|secret|token|key|authorization|credential|apikey|api_key/i;

/** 递归脱敏：敏感键的值替换为 [REDACTED] */
function redact(value: any, depth = 0): any {
  if (depth > 10) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 请求/响应体 → 可落库字符串（脱敏 + 截断） */
function bodyToString(body: any, truncate = BODY_TRUNCATE): string | null {
  if (body === null || body === undefined) return null;
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else if (Buffer.isBuffer(body)) {
    return `[binary ${body.length} bytes]`;
  } else {
    try {
      text = JSON.stringify(redact(body));
    } catch {
      return "[unserializable body]";
    }
  }
  if (text.length > truncate) text = text.slice(0, truncate) + "...[truncated]";
  return text;
}

/** 截断字符串 */
function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function auditLog(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  // 排除健康检查与 CORS 预检
  if (req.method === "OPTIONS" || req.path === "/api/health") {
    next();
    return;
  }

  let capturedBody: any;
  let capturedViaJson = false;

  // 包装 res.json / res.send 抓响应体
  // res.json(body) 内部会再调 res.send(JSON.stringify(body))，因此 send 的字符串会重复覆盖，
  // 这里以 json 捕获的对象为准（更可读）；只有纯 res.send（无 json）时才用 send 的原始值。
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = ((body: any) => {
    capturedBody = body;
    capturedViaJson = true;
    return originalJson(body);
  }) as typeof res.json;

  res.send = ((body: any) => {
    if (!capturedViaJson) {
      capturedBody = body;
    }
    return originalSend(body);
  }) as typeof res.send;

  res.on("finish", () => {
    // 异步落库，不阻塞响应
    void (async () => {
      try {
        let actorType = "system";
        let actorId: number | null = null;
        let actorName: string | null = null;

        if (req.admin?.username) {
          actorType = "admin";
          actorId = req.admin.adminId;
          actorName = req.admin.username;
        } else if (req.user?.userId) {
          actorType = "user";
          actorId = req.user.userId;
          actorName = req.user.phone || String(req.user.userId);
        } else {
          // 公开/未鉴权接口未注入 req.user：先试 Bearer access token，再试 refresh_token cookie，
          // 兜底解析用户身份（admin token 独立 secret 解失败、无凭据 → 保持 system）
          const authHeader = req.headers.authorization;
          if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
              const decoded = verifyToken(authHeader.slice(7));
              if (decoded?.userId) {
                actorType = "user";
                actorId = decoded.userId;
                actorName = decoded.phone || String(decoded.userId);
              }
            } catch {
              /* 无效 access token → 尝试 refresh cookie */
            }
          }
          if (actorType === "system") {
            // 会话是两个 HttpOnly cookie（SameSite=Lax，见 utils/auth-session.ts）：
            //   auth_token    Path=/            access token（JWT_SECRET）→ 所有 /api/* 都带
            //   refresh_token Path=/api/auth    refresh token（REFRESH_TOKEN_SECRET）→ 仅 /api/auth/* 带
            // 两者 JS 都读不到，仅服务端解码用于归属，不改任何业务行为；无效则保持 system。
            const cookies: Record<string, string> = {};
            for (const part of (req.headers.cookie || "").split(";")) {
              const eq = part.indexOf("=");
              if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
            }
            const tryDecode = (token: string | undefined, verify: (t: string) => { userId?: number; phone?: string | null }): boolean => {
              if (!token) return false;
              try {
                const decoded = verify(token);
                if (decoded?.userId) {
                  actorType = "user";
                  actorId = decoded.userId;
                  actorName = decoded.phone || String(decoded.userId);
                  return true;
                }
              } catch {
                /* 无效 → 尝试下一个凭据 */
              }
              return false;
            };
            if (!tryDecode(cookies.auth_token, verifyToken)) {
              tryDecode(cookies.refresh_token, verifyRefreshToken);
            }
          }
        }

        // req.path 在子路由挂载点会被 Express 剥离成 '/'（req.url 被改写），
        // 必须用 req.originalUrl 取完整路径与查询串
        const fullUrl = req.originalUrl || "";
        const qIdx = fullUrl.indexOf("?");
        const fullPath = qIdx >= 0 ? fullUrl.slice(0, qIdx) : fullUrl;
        const queryStr = qIdx >= 0 ? fullUrl.slice(qIdx) : "";

        await cpQuery(
          `INSERT INTO pt_audit_logs
             (actor_type, actor_id, actor_name, method, path, query, status_code,
              request_body, response_body, ip, user_agent, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            actorType,
            actorId,
            actorName,
            req.method,
            truncate(fullPath, PATH_TRUNCATE),
            truncate(queryStr, QUERY_TRUNCATE),
            res.statusCode,
            bodyToString(req.body),
            bodyToString(capturedBody),
            req.ip,
            truncate(req.headers["user-agent"], UA_TRUNCATE),
            Date.now() - start,
          ]
        );
      } catch (err) {
        logger.error("审计日志写入失败:", err);
      }
    })();
  });

  next();
}

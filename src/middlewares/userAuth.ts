/**
 * 用户 JWT 校验中间件（复用老 website_backend 语义，Redis key 加 pt: 前缀）
 *
 * 支持两种凭证：
 *   - Authorization: Bearer <accessToken>
 *   - Cookie: auth_token=<accessToken>
 *
 * 校验通过后：req.user = TokenPayload，req.token = 原始 accessToken
 */

import { Request, Response, NextFunction } from "express";
import { verifyToken, TokenPayload } from "../utils/jwt";
import redis from "../utils/redis";

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      token?: string;
    }
  }
}

function getCookieToken(req: Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(";").map((s) => s.trim())) {
    const [key, ...rest] = item.split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function userAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const cookieToken = getCookieToken(req, "auth_token");
  const token =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : cookieToken;

  if (!token) {
    res.status(401).json({ error: "未登录，请先登录" });
    return;
  }

  try {
    // 登出黑名单检查
    const isBlacklisted = await redis.get(`pt:bl:${token}`);
    if (isBlacklisted) {
      res.status(401).json({ error: "登录已失效，请重新登录" });
      return;
    }

    const decoded = verifyToken(token);
    req.user = decoded;
    req.token = token;
    next();
  } catch {
    res.status(401).json({ error: "Token 无效或已过期" });
  }
}

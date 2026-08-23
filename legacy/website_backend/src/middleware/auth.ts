import { Request, Response, NextFunction } from "express";
import { verifyToken, TokenPayload } from "../utils/auth";
import redis from "../utils/redis";
import TokenService, { ProxyTokenRow } from "../services/TokenService";

// 扩展 Request 类型以支持 API Key 鉴权
declare global {
  namespace Express {
    interface Request {
      apiToken?: ProxyTokenRow; // API Key 鉴权时填充
    }
  }
}

function getCookieToken(req: Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((item) => item.trim());
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      token?: string;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
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
    // 检查黑名单
    const isBlacklisted = await redis.get(`bl_${token}`);
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

/**
 * API Key 鉴权中间件 - 用于支持用户使用个人中心创建的 API Key 进行鉴权
 * 适用于长期/自动化调用场景（如上传图片、生成视频等）
 *
 * 使用方式: Authorization: Bearer sk-silievo-xxx
 */
export async function apiKeyAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "未提供有效的 API Key" });
    return;
  }

  const apiKey = authHeader.slice(7);

  try {
    // 查询数据库验证 API Key
    const token = await TokenService.findByKey(apiKey);

    if (!token) {
      res.status(401).json({ error: "无效的 API Key" });
      return;
    }

    // 检查 token 状态
    if (token.status !== 1) {
      res.status(403).json({ error: "API Key 已被禁用" });
      return;
    }

    // 检查生效时间
    if (token.start_at && new Date(token.start_at) > new Date()) {
      res.status(403).json({
        error: `API Key 将于 ${new Date(token.start_at).toLocaleString("zh-CN")} 开始生效`,
      });
      return;
    }

    // 检查过期时间
    if (token.expired_at && new Date(token.expired_at) < new Date()) {
      res.status(401).json({ error: "API Key 已过期" });
      return;
    }

    // 检查额度（活动 token quota=0 不检查）
    if (token.quota > 0 && token.used_quota >= token.quota) {
      res.status(402).json({ error: "API Key 额度已用尽" });
      return;
    }

    // 将 token 信息附加到请求对象
    req.apiToken = token;
    next();
  } catch (err) {
    console.error("API Key 验证失败:", err);
    res.status(500).json({ error: "API Key 验证失败" });
  }
}

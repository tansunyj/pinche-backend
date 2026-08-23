/**
 * 管理端 JWT 中间件（pt_admins 管理员，role: super_admin / operator）
 *
 * 独立 secret（ADMIN_JWT_SECRET），与用户端 JWT 完全隔离。
 * 验签后每请求回源 pt_admins 校验账号仍启用（防注销/封禁后 token 仍有效）。
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { cpQuery } from "../config/db";

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!ADMIN_JWT_SECRET || ADMIN_JWT_SECRET.length < 16) {
  throw new Error("ADMIN_JWT_SECRET 未配置或长度不足 16 位，请检查 .env");
}

export interface AdminPayload {
  adminId: number;
  username: string;
  role: string; // super_admin | operator
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminPayload;
    }
  }
}

export function generateAdminToken(payload: AdminPayload): string {
  return jwt.sign(payload, ADMIN_JWT_SECRET, {
    expiresIn: (process.env.ADMIN_JWT_EXPIRES_IN || "7d") as any,
  });
}

export function verifyAdminToken(token: string): AdminPayload | null {
  try {
    return jwt.verify(token, ADMIN_JWT_SECRET) as AdminPayload;
  } catch {
    return null;
  }
}

export async function adminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: 请提供有效的管理令牌" });
    return;
  }

  const decoded = verifyAdminToken(authHeader.slice(7));
  if (!decoded) {
    res.status(401).json({ error: "Unauthorized: 管理令牌无效或已过期" });
    return;
  }

  // 回源校验账号仍启用
  try {
    const rows = await cpQuery(
      "SELECT id, username, role, status FROM pt_admins WHERE id = ? AND status = 1 LIMIT 1",
      [decoded.adminId]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(401).json({ error: "Unauthorized: 管理员账号不可用" });
      return;
    }
    req.admin = {
      adminId: rows[0].id,
      username: rows[0].username,
      role: rows[0].role,
    };
    next();
  } catch (err) {
    console.error("adminAuth 回源校验失败:", err);
    res.status(500).json({ error: "服务器内部错误" });
  }
}

/** 仅超管可执行（发车/关闭车次等敏感操作） */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  // pt_admins.role 存的是 SUPER_ADMIN/OPERATOR（大写），此处统一小写比较
  if (!req.admin || (req.admin.role || "").toLowerCase() !== "super_admin") {
    res.status(403).json({ error: "Forbidden: 需要超管权限" });
    return;
  }
  next();
}

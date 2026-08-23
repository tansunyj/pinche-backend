import { Request, Response, NextFunction } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "未登录，请先登录" });
    return;
  }

  if (req.user.role !== "admin") {
    res.status(403).json({ error: "需要管理员权限" });
    return;
  }

  next();
}

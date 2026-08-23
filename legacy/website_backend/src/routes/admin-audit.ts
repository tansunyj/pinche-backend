/**
 * 管理员审计日志查询接口
 *
 *  GET /api/admin/audit-logs
 *    query: page, pageSize, category, action, targetType, targetId,
 *           actorId, targetUserId, q, start_date, end_date
 *
 *  GET /api/admin/audit-logs/meta —— 过滤下拉字典
 *  GET /api/admin/audit-logs/:id  —— 单条详情（含 before/after JSON）
 */

import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";

const router = Router();

router.use(authMiddleware, requireAdmin);

router.get("/meta", async (_req: Request, res: Response) => {
  try {
    const [actionsRows] = await pool.execute(
      'SELECT DISTINCT action FROM user_audit_log ORDER BY action ASC LIMIT 200'
    );
    const [targetTypesRows] = await pool.execute(
      'SELECT DISTINCT targetType FROM user_audit_log WHERE targetType IS NOT NULL ORDER BY targetType ASC LIMIT 100'
    );
    const [categoriesRows] = await pool.execute(
      'SELECT DISTINCT category FROM user_audit_log ORDER BY category ASC'
    );

    res.json({
      success: true,
      data: {
        actions: (actionsRows as any[]).map((r: any) => r.action),
        target_types: (targetTypesRows as any[]).map((r: any) => r.targetType),
        categories: (categoriesRows as any[]).map((r: any) => r.category).filter(Boolean),
      },
    });
  } catch (e: any) {
    console.error("[admin-audit] meta error:", e?.message || e);
    res.status(500).json({ success: false, error: "读取失败" });
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const {
      page = 1, pageSize = 20,
      category, action, targetType, targetId,
      actorId, targetUserId, q,
      start_date, end_date,
    } = req.query as Record<string, string | undefined>;

    const conditions: string[] = [];
    const params: any[] = [];

    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }
    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (targetType) {
      conditions.push('targetType = ?');
      params.push(targetType);
    }
    if (targetId) {
      conditions.push('targetId = ?');
      params.push(targetId);
    }
    if (actorId) {
      conditions.push('actorId = ?');
      params.push(actorId);
    }
    if (targetUserId) {
      conditions.push('targetUserId = ?');
      params.push(targetUserId);
    }
    if (start_date) {
      conditions.push('createdAt >= ?');
      params.push(start_date);
    }
    if (end_date) {
      conditions.push('createdAt <= ?');
      params.push(end_date);
    }
    if (q) {
      conditions.push('(action LIKE ? OR targetType LIKE ? OR targetId LIKE ?)');
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const take = Math.min(parseInt(String(pageSize)) || 20, 200);
    const skip = (Math.max(parseInt(String(page)) || 1, 1) - 1) * take;

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM user_audit_log ${whereClause}`,
      params
    );
    const total = (countRows as any[])[0]?.total || 0;

    const [rows] = await pool.execute(
      `SELECT
        id, actorId, actorRole, action, category,
        targetType, targetId, targetUserId,
        reason, ip, userAgent, requestPath, httpMethod, statusCode, createdAt
      FROM user_audit_log
      ${whereClause}
      ORDER BY createdAt DESC
      LIMIT ? OFFSET ?`,
      [...params, take, skip]
    );

    // 计算 before/after 大小
    const ids = (rows as any[]).map((r: any) => r.id);
    let sizesMap: Record<string, { before: number; after: number }> = {};
    if (ids.length > 0) {
      const [sizedRows] = await pool.execute(
        'SELECT id, `before`, `after` FROM user_audit_log WHERE id IN (' + ids.map(() => '?').join(',') + ')',
        ids
      );
      sizesMap = Object.fromEntries((sizedRows as any[]).map((r: any) => [
        r.id,
        {
          before: r.before ? Buffer.byteLength(r.before, "utf8") : 0,
          after: r.after ? Buffer.byteLength(r.after, "utf8") : 0,
        },
      ]));
    }

    res.json({
      success: true,
      data: {
        logs: (rows as any[]).map((r: any) => ({
          ...r,
          before_size: sizesMap[r.id]?.before ?? 0,
          after_size: sizesMap[r.id]?.after ?? 0,
        })),
        total,
        page: parseInt(String(page)) || 1,
        pageSize: take,
      },
    });
  } catch (e: any) {
    console.error("[admin-audit] list error:", e?.message || e);
    res.status(500).json({ success: false, error: "查询失败" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM user_audit_log WHERE id = ?`,
      [req.params.id]
    );
    const row = (rows as any[])[0];
    if (!row) {
      res.status(404).json({ success: false, error: "记录不存在" });
      return;
    }

    let beforeParsed: unknown = null;
    let afterParsed: unknown = null;
    try { beforeParsed = row.before ? JSON.parse(row.before) : null; } catch { beforeParsed = row.before; }
    try { afterParsed = row.after ? JSON.parse(row.after) : null; } catch { afterParsed = row.after; }

    res.json({
      success: true,
      data: {
        ...row,
        beforeParsed,
        afterParsed,
      },
    });
  } catch (e: any) {
    console.error("[admin-audit] detail error:", e?.message || e);
    res.status(500).json({ success: false, error: "查询失败" });
  }
});

export default router;

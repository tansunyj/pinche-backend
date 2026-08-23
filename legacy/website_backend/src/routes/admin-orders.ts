import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";

const router = Router();

router.use(authMiddleware, requireAdmin);

router.get("/", async (req: Request, res: Response) => {
  try {
    const { status, type, q } = req.query;
    const conditions: string[] = [];
    const params: any[] = [];

    if (status && status !== "all") {
      conditions.push('o.status = ?');
      params.push(String(status));
    }
    if (type && type !== "all") {
      conditions.push('o.type = ?');
      params.push(String(type));
    }
    if (q) {
      conditions.push('(o.item_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [orders] = await pool.execute(
      `SELECT
        o.*,
        u.id as buyer_id, u.username as buyer_username, u.email as buyer_email
      FROM \`order\` o
      LEFT JOIN users u ON o.buyer_id = u.id
      ${whereClause}
      ORDER BY o.created_at DESC`,
      params
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM \`order\` o ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: {
        orders: (orders as any[]).map((o: any) => ({
          ...o,
          buyer: o.buyer_id ? {
            id: o.buyer_id,
            username: o.buyer_username,
            email: o.buyer_email,
          } : null,
        })),
        total: (countRows as any[])[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error("Admin list orders error:", error);
    res.status(500).json({ success: false, error: "获取订单列表失败" });
  }
});

router.get("/summary", async (_req: Request, res: Response) => {
  try {
    const [[totalRow], [paidRow], [pendingRow], [amountRow]] = await Promise.all([
      pool.execute('SELECT COUNT(*) as count FROM `order`'),
      pool.execute('SELECT COUNT(*) as count FROM `order` WHERE status = ?', ['paid']),
      pool.execute('SELECT COUNT(*) as count FROM `order` WHERE status = ?', ['pending']),
      pool.execute('SELECT COALESCE(SUM(amount), 0) as total FROM `order`'),
    ]);

    res.json({
      success: true,
      data: {
        totalOrders: (totalRow as any[])[0]?.count || 0,
        paidOrders: (paidRow as any[])[0]?.count || 0,
        pendingOrders: (pendingRow as any[])[0]?.count || 0,
        totalAmount: (amountRow as any[])[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error("Admin order summary error:", error);
    res.status(500).json({ success: false, error: "获取订单统计失败" });
  }
});

export default router;

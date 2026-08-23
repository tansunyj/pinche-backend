import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";

const router = Router();

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const { type, page = "1", limit = "20" } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const conditions: string[] = [];
    const params: any[] = [];

    if (type && type !== "全部") {
      conditions.push('type = ?');
      params.push(type);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [skills] = await pool.execute(
      `SELECT
        s.*,
        u.id as seller_id, u.username as seller_username, u.avatar as seller_avatar
      FROM skill s
      LEFT JOIN user_users u ON s.seller_id = u.id
      ${whereClause}
      ORDER BY s.sales DESC
      LIMIT ? OFFSET ?`,
      [...params, limitNum, skip]
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM skill ${whereClause}`,
      params
    );

    res.json({
      skills: (skills as any[]).map((s: any) => ({
        ...s,
        seller: s.seller_id ? { id: s.seller_id, username: s.seller_username, avatar: s.seller_avatar } : null,
      })),
      total: (countRows as any[])[0]?.total || 0,
      page: pageNum,
      limit: limitNum,
    });
  } catch (error) {
    console.error("Get skills error:", error);
    res.status(500).json({ error: "获取技能列表失败" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute(
      `SELECT
        s.*,
        u.id as seller_id, u.username as seller_username, u.avatar as seller_avatar
      FROM skill s
      LEFT JOIN user_users u ON s.seller_id = u.id
      WHERE s.id = ?`,
      [req.params.id]
    );
    const skill = (rows as any[])[0];

    if (!skill) {
      res.status(404).json({ error: "技能不存在" });
      return;
    }

    res.json({
      ...skill,
      seller: skill.seller_id ? { id: skill.seller_id, username: skill.seller_username, avatar: skill.seller_avatar } : null,
    });
  } catch (error) {
    console.error("Get skill error:", error);
    res.status(500).json({ error: "获取技能详情失败" });
  }
});

router.post(
  "/",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { name, description, type, price } = req.body;

      if (!name || !description || !price) {
        res.status(400).json({ error: "名称、描述和价格不能为空" });
        return;
      }

      const skillId = generateId();
      await pool.execute(
        `INSERT INTO skill (id, name, description, type, price, seller_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [skillId, name, description, type || "技能模块", price, req.user!.userId]
      );

      const [rows] = await pool.execute(
        `SELECT
          s.*,
          u.id as seller_id, u.username as seller_username, u.avatar as seller_avatar
        FROM skill s
        LEFT JOIN user_users u ON s.seller_id = u.id
        WHERE s.id = ?`,
        [skillId]
      );
      const skill = (rows as any[])[0];

      res.status(201).json({
        ...skill,
        seller: skill.seller_id ? { id: skill.seller_id, username: skill.seller_username, avatar: skill.seller_avatar } : null,
      });
    } catch (error) {
      console.error("Create skill error:", error);
      res.status(500).json({ error: "创建技能失败" });
    }
  }
);

router.post(
  "/:id/buy",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const [skillRows] = await pool.execute('SELECT * FROM skill WHERE id = ?', [req.params.id]);
      const skill = (skillRows as any[])[0];

      if (!skill) {
        res.status(404).json({ error: "技能不存在" });
        return;
      }

      const [buyerRows] = await pool.execute(
        'SELECT balance FROM user_users WHERE id = ?',
        [req.user!.userId]
      );
      const buyer = (buyerRows as any[])[0];

      if (!buyer || buyer.balance < skill.price) {
        res.status(400).json({ error: "硅币余额不足" });
        return;
      }

      const orderId = generateId();

      await pool.execute(
        `INSERT INTO \`order\` (id, type, item_id, item_name, amount, buyer_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'paid', NOW(), NOW())`,
        [orderId, 'skill', skill.id, skill.name, skill.price, req.user!.userId]
      );

      await pool.execute(
        'UPDATE user_users SET balance = balance - ? WHERE id = ?',
        [skill.price, req.user!.userId]
      );

      await pool.execute(
        'UPDATE skill SET sales = sales + 1 WHERE id = ?',
        [skill.id]
      );

      const [orderRows] = await pool.execute('SELECT * FROM `order` WHERE id = ?', [orderId]);

      res.json({ order: (orderRows as any[])[0], message: "购买成功" });
    } catch (error) {
      console.error("Buy skill error:", error);
      res.status(500).json({ error: "购买失败" });
    }
  }
);

export default router;

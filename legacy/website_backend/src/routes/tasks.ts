import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";

const router = Router();

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const { type, status, page = "1", limit = "20" } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const conditions: string[] = [];
    const params: any[] = [];

    if (type && type !== "全部") {
      conditions.push('type = ?');
      params.push(type);
    }
    if (status && status !== "全部") {
      conditions.push('status = ?');
      params.push(status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [tasks] = await pool.execute(
      `SELECT
        t.*,
        u.id as author_id, u.username as author_username, u.avatar as author_avatar
      FROM task t
      LEFT JOIN user_users u ON t.author_id = u.id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?`,
      [...params, limitNum, skip]
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM task ${whereClause}`,
      params
    );

    res.json({
      tasks: (tasks as any[]).map((t: any) => ({
        ...t,
        author: t.author_id ? { id: t.author_id, username: t.author_username, avatar: t.author_avatar } : null,
      })),
      total: (countRows as any[])[0]?.total || 0,
      page: pageNum,
      limit: limitNum,
    });
  } catch (error) {
    console.error("Get tasks error:", error);
    res.status(500).json({ error: "获取任务失败" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute(
      `SELECT
        t.*,
        u.id as author_id, u.username as author_username, u.avatar as author_avatar
      FROM task t
      LEFT JOIN user_users u ON t.author_id = u.id
      WHERE t.id = ?`,
      [req.params.id]
    );
    const task = (rows as any[])[0];

    if (!task) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }

    res.json({
      ...task,
      author: task.author_id ? { id: task.author_id, username: task.author_username, avatar: task.author_avatar } : null,
    });
  } catch (error) {
    console.error("Get task error:", error);
    res.status(500).json({ error: "获取任务详情失败" });
  }
});

router.post(
  "/",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { title, description, type, reward } = req.body;

      if (!title || !description) {
        res.status(400).json({ error: "标题和描述不能为空" });
        return;
      }

      const [userRows] = await pool.execute(
        'SELECT balance FROM user_users WHERE id = ?',
        [req.user!.userId]
      );
      const user = (userRows as any[])[0];

      if (!user || user.balance < (reward || 0)) {
        res.status(400).json({ error: "硅币余额不足" });
        return;
      }

      const taskId = generateId();
      await pool.execute(
        `INSERT INTO task (id, title, description, type, reward, author_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', NOW(), NOW())`,
        [taskId, title, description, type || "任务", reward || 0, req.user!.userId]
      );

      if (reward > 0) {
        await pool.execute(
          'UPDATE user_users SET balance = balance - ? WHERE id = ?',
          [reward, req.user!.userId]
        );
      }

      const [rows] = await pool.execute(
        `SELECT
          t.*,
          u.id as author_id, u.username as author_username, u.avatar as author_avatar
        FROM task t
        LEFT JOIN user_users u ON t.author_id = u.id
        WHERE t.id = ?`,
        [taskId]
      );
      const task = (rows as any[])[0];

      res.status(201).json({
        ...task,
        author: task.author_id ? { id: task.author_id, username: task.author_username, avatar: task.author_avatar } : null,
      });
    } catch (error) {
      console.error("Create task error:", error);
      res.status(500).json({ error: "创建任务失败" });
    }
  }
);

router.post(
  "/:id/accept",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const [taskRows] = await pool.execute('SELECT * FROM task WHERE id = ?', [req.params.id]);
      const task = (taskRows as any[])[0];

      if (!task) {
        res.status(404).json({ error: "任务不存在" });
        return;
      }

      if (task.status !== "open") {
        res.status(400).json({ error: "任务已被接取" });
        return;
      }

      await pool.execute(
        'UPDATE task SET status = ?, assignee_id = ?, updated_at = NOW() WHERE id = ?',
        ['in_progress', req.user!.userId, req.params.id]
      );

      const [rows] = await pool.execute(
        `SELECT
          t.*,
          u.id as author_id, u.username as author_username, u.avatar as author_avatar
        FROM task t
        LEFT JOIN user_users u ON t.author_id = u.id
        WHERE t.id = ?`,
        [req.params.id]
      );
      const updated = (rows as any[])[0];

      res.json({
        ...updated,
        author: updated.author_id ? { id: updated.author_id, username: updated.author_username, avatar: updated.author_avatar } : null,
      });
    } catch (error) {
      console.error("Accept task error:", error);
      res.status(500).json({ error: "接取任务失败" });
    }
  }
);

router.post(
  "/:id/complete",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const [taskRows] = await pool.execute('SELECT * FROM task WHERE id = ?', [req.params.id]);
      const task = (taskRows as any[])[0];

      if (!task) {
        res.status(404).json({ error: "任务不存在" });
        return;
      }

      if (task.assignee_id !== req.user!.userId) {
        res.status(403).json({ error: "无权操作此任务" });
        return;
      }

      await pool.execute(
        'UPDATE task SET status = ?, updated_at = NOW() WHERE id = ?',
        ['completed', req.params.id]
      );

      if (task.assignee_id && task.reward > 0) {
        await pool.execute(
          'UPDATE user_users SET balance = balance + ? WHERE id = ?',
          [task.reward, task.assignee_id]
        );
      }

      const [rows] = await pool.execute('SELECT * FROM task WHERE id = ?', [req.params.id]);
      res.json((rows as any[])[0]);
    } catch (error) {
      console.error("Complete task error:", error);
      res.status(500).json({ error: "完成任务失败" });
    }
  }
);

export default router;

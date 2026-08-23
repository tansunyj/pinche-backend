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

    const [posts] = await pool.execute(
      `SELECT
        p.*,
        u.id as author_id, u.username as author_username, u.avatar as author_avatar,
        (SELECT COUNT(*) FROM comment WHERE post_id = p.id) as comment_count,
        (SELECT COUNT(*) FROM \`like\` WHERE post_id = p.id) as like_count
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?`,
      [...params, limitNum, skip]
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM posts ${whereClause}`,
      params
    );

    const formattedPosts = (posts as any[]).map((post) => ({
      id: post.id,
      title: post.title,
      content: post.content,
      type: post.type,
      agent: post.author_username || post.agent,
      likes: post.like_count,
      replies: post.comment_count,
      time: post.created_at,
      author: post.author_id ? {
        id: post.author_id,
        username: post.author_username,
        avatar: post.author_avatar,
      } : null,
    }));

    res.json({ posts: formattedPosts, total: (countRows as any[])[0]?.total || 0, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error("Get posts error:", error);
    res.status(500).json({ error: "获取帖子失败" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [postRows] = await pool.execute(
      `SELECT
        p.*,
        u.id as author_id, u.username as author_username, u.avatar as author_avatar
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.id = ?`,
      [req.params.id]
    );
    const post = (postRows as any[])[0];

    if (!post) {
      res.status(404).json({ error: "帖子不存在" });
      return;
    }

    const [commentRows] = await pool.execute(
      `SELECT
        c.*,
        u.id as author_id, u.username as author_username, u.avatar as author_avatar
      FROM comment c
      LEFT JOIN users u ON c.author_id = u.id
      WHERE c.post_id = ?
      ORDER BY c.created_at DESC`,
      [req.params.id]
    );

    const [likeRows] = await pool.execute(
      'SELECT user_id FROM `like` WHERE post_id = ?',
      [req.params.id]
    );

    res.json({
      ...post,
      author: post.author_id ? { id: post.author_id, username: post.author_username, avatar: post.author_avatar } : null,
      likes: (likeRows as any[]).length,
      likedBy: (likeRows as any[]).map((l) => l.user_id),
      commentList: (commentRows as any[]).map((c) => ({
        ...c,
        author: c.author_id ? { id: c.author_id, username: c.author_username, avatar: c.author_avatar } : null,
      })),
    });
  } catch (error) {
    console.error("Get post error:", error);
    res.status(500).json({ error: "获取帖子详情失败" });
  }
});

router.post(
  "/",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { title, content, type } = req.body;

      if (!title || !content) {
        res.status(400).json({ error: "标题和内容不能为空" });
        return;
      }

      const postId = generateId();
      await pool.execute(
        `INSERT INTO posts (id, title, content, type, agent, author_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [postId, title, content, type || "帖子", req.user!.email, req.user!.userId]
      );

      const [rows] = await pool.execute(
        `SELECT
          p.*,
          u.id as author_id, u.username as author_username, u.avatar as author_avatar
        FROM posts p
        LEFT JOIN users u ON p.author_id = u.id
        WHERE p.id = ?`,
        [postId]
      );
      const post = (rows as any[])[0];

      res.status(201).json({
        ...post,
        author: post.author_id ? { id: post.author_id, username: post.author_username, avatar: post.author_avatar } : null,
      });
    } catch (error) {
      console.error("Create post error:", error);
      res.status(500).json({ error: "创建帖子失败" });
    }
  }
);

router.post(
  "/:id/like",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const postId = req.params.id;
      const userId = req.user!.userId;

      const [existingRows] = await pool.execute(
        'SELECT id FROM `like` WHERE post_id = ? AND user_id = ?',
        [postId, userId]
      );
      const existing = (existingRows as any[])[0];

      if (existing) {
        await pool.execute('DELETE FROM `like` WHERE id = ?', [existing.id]);
        res.json({ liked: false });
      } else {
        const likeId = generateId();
        await pool.execute(
          'INSERT INTO `like` (id, post_id, user_id, created_at) VALUES (?, ?, ?, NOW())',
          [likeId, postId, userId]
        );
        res.json({ liked: true });
      }
    } catch (error) {
      console.error("Like error:", error);
      res.status(500).json({ error: "操作失败" });
    }
  }
);

router.post(
  "/:id/comment",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { content } = req.body;
      if (!content) {
        res.status(400).json({ error: "评论内容不能为空" });
        return;
      }

      const commentId = generateId();
      await pool.execute(
        `INSERT INTO comment (id, content, post_id, author_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [commentId, content, req.params.id, req.user!.userId]
      );

      const [rows] = await pool.execute(
        `SELECT
          c.*,
          u.id as author_id, u.username as author_username, u.avatar as author_avatar
        FROM comment c
        LEFT JOIN users u ON c.author_id = u.id
        WHERE c.id = ?`,
        [commentId]
      );
      const comment = (rows as any[])[0];

      res.status(201).json({
        ...comment,
        author: comment.author_id ? { id: comment.author_id, username: comment.author_username, avatar: comment.author_avatar } : null,
      });
    } catch (error) {
      console.error("Comment error:", error);
      res.status(500).json({ error: "评论失败" });
    }
  }
);

export default router;

import express, { Request, Response, NextFunction } from 'express';
import pool from '../db/mysql';
import { authMiddleware } from '../middleware/auth';
import crypto from 'crypto';

const router = express.Router();

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'silievo_jwt_secret_key') {
    throw new Error('JWT_SECRET 未配置或仍为弱默认值，已拒绝启动。');
  }
  return secret;
}

function hashAgentSecret(secret: string): string {
  return crypto
    .createHmac("sha256", getJwtSecret())
    .update(secret)
    .digest("hex");
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
}

// 混合认证中间件：支持 User JWT 或 Agent API Key
const mixedAuthMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  // 1. 尝试 Agent API Key 认证
  if (authHeader && authHeader.startsWith('Bearer sk_sili_')) {
    try {
      const token = authHeader.split(' ')[1];
      const apiKeyHash = hashAgentSecret(token);
      const [rows] = await pool.execute(
        'SELECT id, name, status, owner_id FROM agent WHERE api_key_hash = ?',
        [apiKeyHash]
      );
      const agent = (rows as any[])[0];
      if (agent) {
        (req as any).agentAuth = agent;
        return next();
      }
    } catch (e) {
      console.error("Agent Auth Error in Feedback:", e);
    }
  }

  // 2. 退级到 User JWT 认证
  return authMiddleware(req, res, next);
};

// 获取留言列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status = 'active', limit = 50 } = req.query;

    const [feedbacks] = await pool.execute(
      `SELECT
        f.*,
        u.username, u.avatar as user_avatar,
        a.name as agent_name, a.avatar as agent_avatar
      FROM feedback f
      LEFT JOIN users u ON f.user_id = u.id
      LEFT JOIN agent a ON f.agent_id = a.id
      WHERE f.status = ?
      ORDER BY f.likes DESC, f.created_at DESC
      LIMIT ?`,
      [String(status), Number(limit)]
    );

    res.json((feedbacks as any[]).map((f: any) => ({
      ...f,
      user: f.user_id ? { username: f.username, avatar: f.user_avatar } : null,
      agent: f.agent_id ? { name: f.agent_name, avatar: f.agent_avatar } : null,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 发布新留言
router.post('/', mixedAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { content, isAgent } = req.body;

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: '留言内容不能为空' });
      return;
    }

    let userId = null;
    let agentId = null;
    let finalIsAgent = !!isAgent;

    // 如果是 Agent API Key 调用的
    if ((req as any).agentAuth) {
      agentId = (req as any).agentAuth.id;
      userId = (req as any).agentAuth.owner_id; // 可能为空
      finalIsAgent = true; // 强制标记为 Agent
    } else if ((req as any).user) {
      // 如果是普通 User 调用的
      userId = (req as any).user.userId || (req as any).user.id;
      if (isAgent) {
        const [agentRows] = await pool.execute(
          'SELECT id FROM agent WHERE owner_id = ?',
          [userId]
        );
        const agent = (agentRows as any[])[0];
        if (agent) {
          agentId = agent.id;
        }
      }
    }

    const feedbackId = generateId();
    await pool.execute(
      `INSERT INTO feedback (id, content, is_agent, user_id, agent_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
      [feedbackId, content, finalIsAgent, userId, agentId]
    );

    const [rows] = await pool.execute(
      `SELECT
        f.*,
        u.username, u.avatar as user_avatar,
        a.name as agent_name, a.avatar as agent_avatar
      FROM feedback f
      LEFT JOIN users u ON f.user_id = u.id
      LEFT JOIN agent a ON f.agent_id = a.id
      WHERE f.id = ?`,
      [feedbackId]
    );
    const feedback = (rows as any[])[0];

    res.json({
      ...feedback,
      user: feedback.user_id ? { username: feedback.username, avatar: feedback.user_avatar } : null,
      agent: feedback.agent_id ? { name: feedback.agent_name, avatar: feedback.agent_avatar } : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 可选认证中间件
const optionalAuthMiddleware = async (req: Request, res: Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }
  next();
};

// 点赞留言
router.post('/:id/like', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await pool.execute(
      'UPDATE feedback SET likes = likes + 1 WHERE id = ?',
      [id]
    );

    const [rows] = await pool.execute('SELECT * FROM feedback WHERE id = ?', [id]);
    res.json((rows as any[])[0]);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 标记为已解决 (管理员或发布者)
router.patch('/:id/resolve', mixedAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    const agentAuth = (req as any).agentAuth;

    const [feedbackRows] = await pool.execute('SELECT * FROM feedback WHERE id = ?', [id]);
    const feedback = (feedbackRows as any[])[0];

    if (!feedback) {
      res.status(404).json({ error: '留言不存在' });
      return;
    }

    let hasPermission = false;
    const userId = user?.userId || user?.id;
    if (user && (feedback.user_id === userId || user.role === 'admin')) {
      hasPermission = true;
    } else if (agentAuth && feedback.agent_id === agentAuth.id) {
      hasPermission = true;
    }

    if (!hasPermission) {
      res.status(403).json({ error: '无权操作' });
      return;
    }

    await pool.execute(
      'UPDATE feedback SET status = ?, updated_at = NOW() WHERE id = ?',
      ['resolved', id]
    );

    const [rows] = await pool.execute('SELECT * FROM feedback WHERE id = ?', [id]);
    res.json((rows as any[])[0]);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 删除留言
router.delete('/:id', mixedAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = (req as any).user;
    const agentAuth = (req as any).agentAuth;

    const [feedbackRows] = await pool.execute('SELECT * FROM feedback WHERE id = ?', [id]);
    const feedback = (feedbackRows as any[])[0];

    if (!feedback) {
      res.status(404).json({ error: '留言不存在' });
      return;
    }

    let hasPermission = false;
    const userId = user?.userId || user?.id;
    if (user && (feedback.user_id === userId || user.role === 'admin')) {
      hasPermission = true;
    } else if (agentAuth && feedback.agent_id === agentAuth.id) {
      hasPermission = true;
    }

    if (!hasPermission) {
      res.status(403).json({ error: '无权操作' });
      return;
    }

    await pool.execute(
      'UPDATE feedback SET status = ?, updated_at = NOW() WHERE id = ?',
      ['deleted', id]
    );

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

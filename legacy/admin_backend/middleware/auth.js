const jwt = require('jsonwebtoken');
const { query } = require('../db/init');

const JWT_SECRET = process.env.JWT_SECRET || 'silievo-relay-secret-2024';

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const decoded = verifyToken(authHeader.slice(7));
    if (decoded) {
      req.user = decoded;
      return next();
    }
  }
  res.status(401).json({ error: 'Unauthorized: 请提供有效的管理令牌' });
}

function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: 需要管理员权限' });
  }
  next();
}

/**
 * 更新用户最后登录时间的中间件
 * 适用于验证用户 JWT 的接口（非管理员接口）
 */
async function updateLastLoginMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = verifyToken(token);
    if (decoded && decoded.userId) {
      // 将用户信息附加到请求
      req.user = decoded;
      // 异步更新最后登录时间（不阻塞请求）
      query(
        'UPDATE user_users SET last_login_at = NOW() WHERE id = ?',
        [decoded.userId]
      ).catch(() => {
        // 静默处理错误，不影响主流程
      });
    }
  }
  next();
}

module.exports = { generateToken, verifyToken, authMiddleware, adminMiddleware, updateLastLoginMiddleware, JWT_SECRET };

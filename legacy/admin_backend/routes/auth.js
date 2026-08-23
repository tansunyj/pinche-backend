const bcrypt = require('bcryptjs');
const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { generateToken } = require('../middleware/auth');
const { createLimiter, getClientIp } = require('../middleware/rateLimit');
const captcha = require('../middleware/captcha');

// 登录失败限流：15 分钟内同一 IP 失败 10 次 → 封禁 30 分钟
const loginLimiter = createLimiter({
  name: 'login',
  windowMs: 15 * 60 * 1000,
  max: 10,
  blockMs: 30 * 60 * 1000,
  message: '登录失败次数过多，请稍后再试',
});

// 改密限流：1 小时内失败 5 次 → 封禁 1 小时
const changePwdLimiter = createLimiter({
  name: 'change-password',
  windowMs: 60 * 60 * 1000,
  max: 5,
  blockMs: 60 * 60 * 1000,
  message: '操作过于频繁，请稍后再试',
});

// 日志函数
function logAuth(level, message, data) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Auth:${level}]`;
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

router.post('/login', loginLimiter.middleware, captcha(), async (req, res) => {
  const { username, password } = req.body;
  const clientIp = getClientIp(req);

  logAuth('INFO', `收到登录请求`, { username, ip: clientIp, hasPassword: !!password });

  if (!username || !password) {
    logAuth('WARN', '登录参数缺失', { username: !!username, password: !!password });
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  try {
    logAuth('DEBUG', `查询用户: ${username}`);
    const rows = await query('SELECT * FROM proxy_users WHERE username = ?', [username]);
    logAuth('DEBUG', `查询结果: 找到 ${rows.length} 条记录`);

    const user = rows[0];

    if (!user) {
      const entry = loginLimiter.recordFailure(req);
      logAuth('WARN', `用户不存在`, { username, ip: clientIp, failCount: entry.count });
      return res.status(401).json({
        error: '用户名或密码错误',
        attemptsLeft: Math.max(0, loginLimiter.max - entry.count),
      });
    }

    logAuth('DEBUG', `找到用户，验证密码...`, { userId: user.id, role: user.role });
    const passwordValid = bcrypt.compareSync(password, user.password);

    if (!passwordValid) {
      const entry = loginLimiter.recordFailure(req);
      logAuth('WARN', `密码错误`, { username, ip: clientIp, failCount: entry.count });
      return res.status(401).json({
        error: '用户名或密码错误',
        attemptsLeft: Math.max(0, loginLimiter.max - entry.count),
      });
    }

    loginLimiter.clear(req);
    const token = generateToken({ id: user.id, username: user.username, role: user.role });
    logAuth('INFO', `登录成功`, { username, userId: user.id, role: user.role });

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    logAuth('ERROR', `登录异常`, { username, error: e.message, code: e.code, stack: e.stack });
    res.status(500).json({ error: '登录失败', detail: e.message });
  }
});

router.post('/change-password', changePwdLimiter.middleware, captcha({ required: false }), async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  try {
    const rows = await query('SELECT * FROM proxy_users WHERE username = ?', [username]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(oldPassword, user.password)) {
      changePwdLimiter.recordFailure(req);
      return res.status(401).json({ error: '原密码错误' });
    }
    const hashed = bcrypt.hashSync(newPassword, 12);
    await query('UPDATE proxy_users SET password = ? WHERE username = ?', [hashed, username]);
    changePwdLimiter.clear(req);
    res.json({ message: '密码修改成功' });
  } catch (e) {
    res.status(500).json({ error: '修改密码失败' });
  }
});

module.exports = router;

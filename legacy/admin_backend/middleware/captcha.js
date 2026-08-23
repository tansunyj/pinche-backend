/**
 * Cloudflare Turnstile 校验中间件工厂
 *
 * 用法：
 *   const captcha = require('./middleware/captcha');
 *   router.post('/login', captcha(), handler);
 *   router.post('/register', captcha({ tokenField: 'cfToken' }), handler);
 *
 * 默认从 req.body.captchaToken 读取 token；校验失败返回 400。
 * 当 TURNSTILE_SECRET_KEY 未配置时自动放行（开发模式友好）。
 */

const { verifyTurnstile } = require('../utils/turnstile');
const { getClientIp } = require('./rateLimit');

function captchaMiddleware(opts = {}) {
  const { tokenField = 'captchaToken', required = true } = opts;
  return async (req, res, next) => {
    const token = req.body && req.body[tokenField];
    const ip = getClientIp(req);
    const result = await verifyTurnstile(token, ip);
    if (!result.success && required) {
      return res.status(400).json({ error: result.error || '人机验证未通过' });
    }
    next();
  };
}

module.exports = captchaMiddleware;

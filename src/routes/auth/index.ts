/**
 * 用户认证路由（挂载 /api/auth）
 *
 * 支持两种账户类型（互斥，pt_users.phone / email 二选一）：
 *   - 手机号 + 短信验证码 登录（未注册自动开户）
 *   - 邮箱 + 邮箱验证码 登录（未注册自动开户，人机验证）
 *
 *   POST   /send-code          发送短信验证码
 *   POST   /send-email-code    发送邮箱验证码
 *   POST   /login              手机号+验证码 登录（未注册自动开户）
 *   POST   /email-login        邮箱+验证码 登录（未注册自动开户）
 *   POST   /refresh            刷新 access token
 *   POST   /logout             登出（黑名单 + 撤销 refresh）
 *   GET    /me                 当前用户
 *   PATCH  /profile            修改昵称/头像
 *   PUT    /password           设置/修改密码（验证码验证手机号后设置）
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { body, validationResult } from "express-validator";
import UserService, { getPublicUser } from "../../services/user";
import {
  issueAuthSession,
  clearAuthCookies,
  matchesRefreshToken,
  revokeRefreshToken,
} from "../../utils/auth-session";
import { verifyRefreshToken } from "../../utils/jwt";
import { userAuth } from "../../middlewares/userAuth";
import redis from "../../utils/redis";
import { sendSmsCode } from "../../utils/sms";
import { sendVerifyCodeMail } from "../../utils/mailer";
import { verifyTurnstile, clientIp } from "../../utils/turnstile";
import { ensureUser, ensureEmailUser } from "../../services/onboarding";

/** 校验 Cloudflare Turnstile（未配置 secret 时放行），失败返回 400 */
async function checkCaptcha(req: Request, res: Response): Promise<boolean> {
  const result = await verifyTurnstile(
    req.body?.captchaToken,
    clientIp(req)
  );
  if (!result.success) {
    res.status(400).json({ error: result.error || "人机验证未通过，请刷新后重试" });
    return false;
  }
  return true;
}

const router = Router();

const PHONE_REGEX = /^1[3-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_REGEX = /^\d{6}$/;

/** 生成 6 位验证码并缓存（pt:auth:code:{phone}，5 分钟），60 秒冷却 */
async function issueCode(phone: string, cooldownKey: string, codeKey: string) {
  const cd = await redis.get(cooldownKey);
  if (cd) return { ok: false as const, error: `请 ${cd} 秒后再试` };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await redis.setex(codeKey, 5 * 60, code);
  await redis.setex(cooldownKey, 60, "60");
  return { ok: true as const, code };
}

// ============ 发送短信验证码 ============
router.post(
  "/send-code",
  [body("phone").matches(PHONE_REGEX).withMessage("请输入有效的手机号")],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { phone } = req.body;

    // 登录验证码 60 秒冷却（防短信轰炸依赖冷却 + 短信平台限流；
    // 人机验证组件只在登录提交前展示，故发送验证码不再校验）
    const cooldownKey = `pt:auth:cd:${phone}`;
    const codeKey = `pt:auth:code:${phone}`;
    const issued = await issueCode(phone, cooldownKey, codeKey);
    if (!issued.ok) {
      res.status(429).json({ error: issued.error });
      return;
    }

    const sms = await sendSmsCode(phone, issued.code);
    const isDev = process.env.NODE_ENV !== "production";
    res.json({
      message: "验证码已发送",
      ...(isDev && sms.devCode ? { devCode: sms.devCode } : {}),
    });
  }
);

// ============ 发送邮箱验证码 ============
router.post(
  "/send-email-code",
  [
    body("email").isEmail().withMessage("请输入有效的邮箱地址").normalizeEmail(),
    body("email").custom((v: string) => EMAIL_REGEX.test(v)).withMessage("请输入有效的邮箱地址"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { email } = req.body;

    // 防刷：60 秒冷却（与短信一致）
    const cooldownKey = `pt:auth:cd:email:${email}`;
    const codeKey = `pt:auth:code:email:${email}`;
    const issued = await issueCode(email, cooldownKey, codeKey);
    if (!issued.ok) {
      res.status(429).json({ error: issued.error });
      return;
    }

    const mail = await sendVerifyCodeMail(email, issued.code, {
      subject: "【Token拼车】邮箱验证码",
      expiresInMinutes: 5,
    });
    if (!mail.delivered && process.env.NODE_ENV === "production") {
      res.status(500).json({ error: "验证码发送失败，请稍后重试" });
      return;
    }
    const isDev = process.env.NODE_ENV !== "production";
    res.json({
      message: "验证码已发送至邮箱",
      ...(isDev && mail.devCode ? { devCode: mail.devCode } : {}),
    });
  }
);

// ============ 手机号 + 验证码 登录/注册 ============
router.post(
  "/login",
  [
    body("phone").matches(PHONE_REGEX).withMessage("请输入有效的手机号"),
    body("code").matches(CODE_REGEX).withMessage("请输入6位数字验证码"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { phone, code } = req.body;

    // Cloudflare Turnstile 人机验证（防验证码暴力尝试）
    if (!(await checkCaptcha(req, res))) return;

    const storedCode = await redis.get(`pt:auth:code:${phone}`);
    if (!storedCode || storedCode !== code) {
      res.status(400).json({ error: "验证码错误或已过期" });
      return;
    }
    await redis.del(`pt:auth:code:${phone}`);

    try {
      let user = await UserService.findByPhone(phone);
      // 未注册：注册即开户（建 pt_users 用户 + 默认 Key）；已注册：直接登录
      const isNewUser = !user;
      if (!user) {
        user = await ensureUser(phone);
      }

      if (user.status === "DISABLED") {
        res.status(403).json({ error: "账号已被封禁，请联系客服" });
        return;
      }

      await UserService.markLoginSuccess(user.id);

      const { accessToken } = await issueAuthSession(user, res);
      res.json({ token: accessToken, user: getPublicUser(user), isNewUser });
    } catch (error) {
      console.error("Phone login error:", error);
      res.status(500).json({ error: "登录失败，请稍后重试" });
    }
  }
);

// ============ 邮箱 + 验证码 登录/注册（账户类型与手机号互斥：只填 email） ============
router.post(
  "/email-login",
  [
    body("email").isEmail().withMessage("请输入有效的邮箱地址").normalizeEmail(),
    body("email").custom((v: string) => EMAIL_REGEX.test(v)).withMessage("请输入有效的邮箱地址"),
    body("code").matches(CODE_REGEX).withMessage("请输入6位数字验证码"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { email, code } = req.body;

    // Cloudflare Turnstile 人机验证（防验证码暴力尝试）
    if (!(await checkCaptcha(req, res))) return;

    const storedCode = await redis.get(`pt:auth:code:email:${email}`);
    if (!storedCode || storedCode !== code) {
      res.status(400).json({ error: "验证码错误或已过期" });
      return;
    }
    await redis.del(`pt:auth:code:email:${email}`);

    try {
      let user = await UserService.findByEmail(email);
      // 未注册：注册即开户（建 pt_users 用户 + 默认 Key）；已注册：直接登录
      const isNewUser = !user;
      if (!user) {
        user = await ensureEmailUser(email);
      }

      if (user.status === "DISABLED") {
        res.status(403).json({ error: "账号已被封禁，请联系客服" });
        return;
      }

      await UserService.markLoginSuccess(user.id);

      const { accessToken } = await issueAuthSession(user, res);
      res.json({ token: accessToken, user: getPublicUser(user), isNewUser });
    } catch (error) {
      console.error("Email login error:", error);
      res.status(500).json({ error: "登录失败，请稍后重试" });
    }
  }
);

// ============ 刷新 access token ============
router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const cookieHeader = req.headers.cookie || "";
    const refreshCookie = cookieHeader
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("refresh_token="));
    const refreshToken = refreshCookie
      ? decodeURIComponent(refreshCookie.split("=").slice(1).join("="))
      : null;

    if (!refreshToken) {
      res.status(401).json({ error: "刷新凭证不存在" });
      return;
    }

    const payload = verifyRefreshToken(refreshToken);
    const ok = await matchesRefreshToken(payload.userId, refreshToken);
    if (!ok) {
      clearAuthCookies(res);
      res.status(401).json({ error: "刷新凭证无效" });
      return;
    }

    const user = await UserService.findById(payload.userId);
    if (!user || user.status === "DISABLED") {
      clearAuthCookies(res);
      res.status(401).json({ error: "用户不可用" });
      return;
    }

    const { accessToken } = await issueAuthSession(user, res);
    res.json({ token: accessToken, user: getPublicUser(user) });
  } catch {
    clearAuthCookies(res);
    res.status(401).json({ error: "刷新登录状态失败" });
  }
});

// ============ 登出 ============
router.post("/logout", userAuth, async (req: Request, res: Response) => {
  try {
    if (req.token) {
      await redis.setex(`pt:bl:${req.token}`, 7 * 24 * 60 * 60, "true");
    }
    if (req.user?.userId) {
      await revokeRefreshToken(req.user.userId);
    }
    clearAuthCookies(res);
    res.json({ message: "已成功退出登录" });
  } catch {
    res.status(500).json({ error: "退出登录失败" });
  }
});

// ============ 当前用户 ============
router.get("/me", userAuth, async (req: Request, res: Response) => {
  try {
    const user = await UserService.findById(req.user!.userId);
    if (!user) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }
    res.json(getPublicUser(user));
  } catch {
    res.status(500).json({ error: "获取用户信息失败" });
  }
});

// ============ 修改昵称/头像 ============
router.patch(
  "/profile",
  userAuth,
  [
    body("username").optional({ nullable: true }).trim().isLength({ min: 2, max: 50 }).withMessage("昵称长度 2-50 个字符"),
    body("avatar").optional({ nullable: true }).isURL().withMessage("头像必须是URL"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    try {
      const fields: { nickname?: string; avatar_url?: string } = {};
      if (req.body.username !== undefined) fields.nickname = req.body.username;
      if (req.body.name !== undefined) fields.nickname = req.body.name;
      if (req.body.avatar !== undefined) fields.avatar_url = req.body.avatar;

      await UserService.updateProfile(req.user!.userId, fields);
      const user = await UserService.findById(req.user!.userId);
      res.json(getPublicUser(user!));
    } catch {
      res.status(500).json({ error: "更新失败" });
    }
  }
);

// ============ 设置/修改密码（验证码验证手机号） ============
router.put(
  "/password",
  userAuth,
  [
    body("phone").matches(PHONE_REGEX).withMessage("请输入有效的手机号"),
    body("code").matches(CODE_REGEX).withMessage("验证码格式错误"),
    body("newPassword").isLength({ min: 8 }).withMessage("密码至少 8 个字符"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { phone, code, newPassword } = req.body;

    // 验证码必须匹配当前登录手机号
    if (phone !== req.user!.phone) {
      res.status(400).json({ error: "只能为登录手机号设置密码" });
      return;
    }
    const storedCode = await redis.get(`pt:auth:code:${phone}`);
    if (!storedCode || storedCode !== code) {
      res.status(400).json({ error: "验证码错误或已过期" });
      return;
    }
    await redis.del(`pt:auth:code:${phone}`);

    try {
      await UserService.updatePassword(req.user!.userId, newPassword);
      await revokeRefreshToken(req.user!.userId);
      res.json({ message: "密码设置成功，请重新登录" });
    } catch {
      res.status(500).json({ error: "修改密码失败" });
    }
  }
);

export default router;

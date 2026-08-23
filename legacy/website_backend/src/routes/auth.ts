/**
 * 用户认证路由 - 对接 MySQL `silievo`.`user_users` 表
 *
 * 接口列表：
 *   POST   /register/send-code    发送注册验证码
 *   POST   /register              邮箱注册（需要验证码）
 *   POST   /login                 邮箱密码登录
 *   POST   /logout                登出
 *   POST   /refresh               刷新 access token
 *   GET    /me                    当前用户资料
 *   PATCH  /profile               修改昵称/头像
 *   PUT    /change-password       修改密码（需要旧密码）
 *   POST   /verify-email/resend   重发邮箱验证邮件
 *   POST   /verify-email/confirm  确认邮箱验证 token
 *   POST   /forgot-password/send-link  发送密码重置链接
 *   POST   /forgot-password/reset      通过令牌重置密码
 *
 * 注意：
 *   - 注册/登录 在 /api/auth 前缀下，对应 /api/auth/register 等
 *   - 手机号 + 微信/支付宝 OAuth 登录目前是占位（详见对应处理函数）
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { body, validationResult } from "express-validator";
import UserService, { getPublicUser } from "../services/UserService";
import {
  issueAuthSession,
  clearAuthCookies,
  matchesRefreshToken,
  revokeRefreshToken,
  storeOneTimeToken,
  consumeOneTimeToken,
} from "../utils/auth-session-mysql";
import { verifyRefreshToken } from "../utils/auth";
import { authMiddleware } from "../middleware/auth";
import redis from "../utils/redis";
import { sendAuthMail, sendVerifyCodeMail } from "../utils/mailer";
import { verifyTurnstile } from "../utils/turnstile";
import StatsService from "../services/StatsService";
import pool from "../db/mysql";

const router = Router();
const WEB_BASE_URL = process.env.WEB_BASE_URL || "http://localhost:13000";

/**
 * 密码复杂度规则（与前端 src/lib/password.ts 同步）：
 *   - 长度 ≥ 8
 *   - 至少一个小写字母 a-z
 *   - 至少一个大写字母 A-Z
 *   - 至少一个数字 0-9
 *   - 至少一个特殊字符（任意非字母数字）
 */
function passwordComplexity(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("密码格式错误");
  }
  if (value.length < 8) throw new Error("密码至少 8 个字符");
  if (!/[a-z]/.test(value)) throw new Error("密码需包含小写字母 (a-z)");
  if (!/[A-Z]/.test(value)) throw new Error("密码需包含大写字母 (A-Z)");
  if (!/\d/.test(value)) throw new Error("密码需包含数字 (0-9)");
  if (!/[^A-Za-z0-9]/.test(value)) throw new Error("密码需包含特殊字符");
  return true;
}

// ============================================
// 注册验证码 - 发送
// ============================================
router.post(
  "/register/send-code",
  [
    body("email").isEmail().withMessage("请输入有效邮箱").normalizeEmail(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    // Cloudflare Turnstile 校验
    const captchaResult = await verifyTurnstile(
      req.body?.captchaToken,
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip,
    );
    if (!captchaResult.success) {
      res.status(400).json({ error: captchaResult.error || "人机验证未通过" });
      return;
    }

    const { email } = req.body;

    try {
      // 检查邮箱是否已注册
      const existing = await UserService.findByEmail(email);
      if (existing) {
        res.status(409).json({ error: "该邮箱已被注册" });
        return;
      }

      // 防刷：60秒冷却
      const cooldownKey = `register_cd:${email}`;
      const cd = await redis.get(cooldownKey);
      if (cd) {
        res.status(429).json({ error: `请 ${cd} 秒后再试` });
        return;
      }

      // 生成6位验证码
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeKey = `register_code:${email}`;

      // 存储验证码，5分钟有效期
      await redis.setex(codeKey, 5 * 60, code);
      // 60秒冷却
      await redis.setex(cooldownKey, 60, "60");

      // 发送验证码邮件
      try {
        const result = await sendVerifyCodeMail(
          email,
          code,
          { subject: "【SiliEvo】注册验证码", expiresInMinutes: 5 }
        );
        if (!result.delivered) {
          console.error("[注册验证码] 邮件未成功发送，可能 SMTP 未配置");
        }
      } catch (mailErr) {
        console.error("发送注册验证码邮件失败:", mailErr);
        res.status(500).json({ error: "验证码发送失败，请稍后重试" });
        return;
      }

      res.json({ message: "验证码已发送" });
    } catch (error) {
      console.error("Send register code error:", error);
      res.status(500).json({ error: "发送失败，请稍后重试" });
    }
  }
);
// ============================================
// 注册（邮箱 + 验证码）
// ============================================
router.post(
  "/register",
  [
    body("email").isEmail().withMessage("请输入有效邮箱").normalizeEmail(),
    body("password").custom(passwordComplexity),
    body("code").matches(/^\d{6}$/).withMessage("请输入6位数字验证码"),
    body("username")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage("昵称长度 2-50 个字符"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const { email, password, code, username, name, inviteCode } = req.body;
    const displayName = (username || name || "").trim() || null;

    try {
      // 邮箱唯一性
      const existing = await UserService.findByEmail(email);
      if (existing) {
        res.status(409).json({ error: "该邮箱已被注册" });
        return;
      }

      // 验证邮箱验证码
      const codeKey = `register_code:${email}`;
      const storedCode = await redis.get(codeKey);
      if (!storedCode || storedCode !== code) {
        res.status(400).json({ error: "验证码错误或已过期" });
        return;
      }

      // 处理邀请码（使用新的邀请码系统）
      let invitedBy: number | null = null;
      let useInviteCode: string | null = null;
      if (inviteCode) {
        // 查询邀请码
        const [codeRows]: any = await pool.execute(
          "SELECT user_id FROM user_invite_codes WHERE code = ? AND status = 1",
          [inviteCode]
        );
        if (Array.isArray(codeRows) && codeRows.length > 0) {
          invitedBy = codeRows[0].user_id;
          useInviteCode = inviteCode;
        }
      }

      // 创建 user_users 行
      const { userId } = await UserService.createEmailUser({
        email,
        name: displayName,
        password,
        invitedBy,
      });

      // 删除已使用的验证码
      await redis.del(codeKey);

      // 创建邀请关系记录
      if (invitedBy && useInviteCode) {
        try {
          await pool.execute(
            "INSERT INTO user_invites (inviter_id, invitee_id, invite_code, status, registered_at, created_at) VALUES (?, ?, ?, 'registered', NOW(), NOW())",
            [invitedBy, userId, useInviteCode]
          );
        } catch (err) {
          console.error("创建邀请记录失败（已忽略）:", err);
        }
      }

      // 记录新用户注册统计
      StatsService.recordNewUser(userId);

      const user = await UserService.findById(userId);
      if (!user) {
        res.status(500).json({ error: "用户创建后查询失败" });
        return;
      }

      const { accessToken } = await issueAuthSession(user, res);

      res.status(201).json({
        token: accessToken,
        user: getPublicUser(user),
      });
    } catch (error: any) {
      console.error("Register error:", error);
      // 处理 MySQL 唯一键冲突（兜底）
      if (error?.code === "ER_DUP_ENTRY") {
        res.status(409).json({ error: "该邮箱已被注册" });
        return;
      }
      res.status(500).json({ error: "注册失败，请稍后重试" });
    }
  }
);

// ============================================
// 登录（邮箱密码）
// ============================================
router.post(
  "/login",
  [
    body("email").isEmail().withMessage("请输入有效邮箱").normalizeEmail(),
    body("password").notEmpty().withMessage("请输入密码"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const { email, password } = req.body;

    try {
      const user = await UserService.findByEmail(email);
      if (!user) {
        // 不暴露用户是否存在
        res.status(401).json({ error: "邮箱或密码错误" });
        return;
      }

      // 状态检查
      if (user.status === 0) {
        res.status(403).json({ error: "账号已被封禁，请联系客服" });
        return;
      }

      const result = await UserService.verifyPassword(user, password);
      if (result === "locked") {
        res
          .status(429)
          .json({ error: "账号因连续登录失败已临时锁定，请 15 分钟后再试" });
        return;
      }
      if (result === "wrong") {
        res.status(401).json({ error: "邮箱或密码错误" });
        return;
      }

      const ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        req.ip ||
        null;
      await UserService.markLoginSuccess(user.id, ip);

      // 记录用户登录统计（DAU）
      StatsService.recordUserLogin(user.id);

      // 重新拉取最新用户（含登录后字段）
      const fresh = (await UserService.findById(user.id))!;
      const { accessToken } = await issueAuthSession(fresh, res);

      res.json({
        token: accessToken,
        user: getPublicUser(fresh),
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "登录失败，请稍后重试" });
    }
  }
);

// ============================================
// 登出
// ============================================
router.post("/logout", authMiddleware, async (req: Request, res: Response) => {
  try {
    const accessToken = req.token;
    if (accessToken) {
      // 把 access token 加入黑名单 7 天
      await redis.setex(`bl_${accessToken}`, 7 * 24 * 60 * 60, "true");
    }
    if (req.user?.userId) {
      await revokeRefreshToken(req.user.userId);
    }
    clearAuthCookies(res);
    res.json({ message: "已成功退出登录" });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "退出登录失败" });
  }
});

// ============================================
// 刷新 access token
// ============================================
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
    if (!user || user.status === 0) {
      clearAuthCookies(res);
      res.status(401).json({ error: "用户不可用" });
      return;
    }

    const { accessToken } = await issueAuthSession(user, res);
    res.json({ token: accessToken, user: getPublicUser(user) });
  } catch (error) {
    clearAuthCookies(res);
    res.status(401).json({ error: "刷新登录状态失败" });
  }
});

// ============================================
// 当前用户
// ============================================
router.get("/me", authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await UserService.findById(req.user!.userId);
    if (!user) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }
    res.json(getPublicUser(user));
  } catch (error) {
    console.error("Get me error:", error);
    res.status(500).json({ error: "获取用户信息失败" });
  }
});

// ============================================
// 修改个人资料
// ============================================
router.patch(
  "/profile",
  authMiddleware,
  [
    body("username")
      .optional({ nullable: true })
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage("昵称长度 2-50 个字符"),
    body("avatar").optional({ nullable: true }).isURL().withMessage("头像必须是URL"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    try {
      const fields: { name?: string; avatar?: string } = {};
      if (req.body.username !== undefined) fields.name = req.body.username;
      if (req.body.name !== undefined) fields.name = req.body.name;
      if (req.body.avatar !== undefined) fields.avatar = req.body.avatar;

      await UserService.updateProfile(req.user!.userId, fields);
      const user = await UserService.findById(req.user!.userId);
      res.json(getPublicUser(user!));
    } catch (error) {
      console.error("Update profile error:", error);
      res.status(500).json({ error: "更新失败" });
    }
  }
);

// ============================================
// 修改密码（已登录）
// ============================================
router.put(
  "/change-password",
  authMiddleware,
  [
    body("oldPassword").notEmpty().withMessage("请输入原密码"),
    body("newPassword").custom(passwordComplexity),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    try {
      const user = await UserService.findById(req.user!.userId);
      if (!user || !user.password_hash) {
        res.status(400).json({ error: "无法修改密码" });
        return;
      }
      const ok = await bcrypt.compare(req.body.oldPassword, user.password_hash);
      if (!ok) {
        res.status(400).json({ error: "原密码错误" });
        return;
      }
      await UserService.updatePassword(user.id, req.body.newPassword);
      // 安全：踢掉所有会话
      await revokeRefreshToken(user.id);
      res.json({ message: "密码修改成功，请重新登录" });
    } catch (error) {
      console.error("Change password error:", error);
      res.status(500).json({ error: "修改密码失败" });
    }
  }
);

// ============================================
// 邮箱验证 - 重发
// ============================================
router.post(
  "/verify-email/resend",
  [body("email").isEmail().normalizeEmail()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const { email } = req.body;
    const user = await UserService.findByEmail(email);
    // 不暴露邮箱是否存在
    if (!user) {
      res.json({ message: "如果邮箱存在，我们已发送验证邮件" });
      return;
    }
    if (user.email_verified_at) {
      res.json({ message: "该邮箱已验证" });
      return;
    }
    const verifyToken = await storeOneTimeToken({
      scope: "email_verify",
      userId: user.id,
      ttlSeconds: 24 * 60 * 60,
    });
    const verifyUrl = `${WEB_BASE_URL}/verify-email?token=${verifyToken}`;
    const mail = await sendAuthMail(
      user.email!,
      "重新验证你的 SiliEvo 邮箱",
      "点击验证邮箱",
      verifyUrl
    );
    res.json({
      message: "验证邮件已发送",
      verificationPreviewUrl: mail?.previewUrl,
    });
  }
);

// ============================================
// 邮箱验证 - 确认
// ============================================
router.post(
  "/verify-email/confirm",
  [body("token").isString().notEmpty()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const userId = await consumeOneTimeToken({
      scope: "email_verify",
      token: req.body.token,
    });
    if (!userId) {
      res.status(400).json({ error: "验证链接无效或已过期" });
      return;
    }
    await UserService.setEmailVerified(userId);
    res.json({ message: "邮箱验证成功" });
  }
);

// ============================================
// 找回密码 - 发送重置链接
// ============================================
router.post(
  "/forgot-password/send-link",
  [body("email").isEmail().normalizeEmail()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    // Cloudflare Turnstile 校验
    const captchaResult = await verifyTurnstile(
      req.body?.captchaToken,
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip,
    );
    if (!captchaResult.success) {
      res.status(400).json({ error: captchaResult.error || "人机验证未通过" });
      return;
    }

    const { email } = req.body;
    const user = await UserService.findByEmail(email);
    if (!user) {
      // 不暴露邮箱是否存在
      res.json({ message: "如果邮箱存在，我们已发送重置链接" });
      return;
    }

    // 防刷：60秒冷却
    const cooldownKey = `pwd_reset_cd:${email}`;
    const cd = await redis.get(cooldownKey);
    if (cd) {
      res.status(429).json({ error: "请稍后再试" });
      return;
    }

    // 生成一次性重置令牌
    const resetToken = await storeOneTimeToken({
      scope: "pwd_reset",
      userId: user.id,
      ttlSeconds: 30 * 60, // 30分钟有效期
    });

    // 60秒冷却
    await redis.setex(cooldownKey, 60, "60");

    const resetUrl = `${WEB_BASE_URL}/reset-password?token=${resetToken}`;

    // 发送重置链接邮件
    try {
      const result = await sendAuthMail(
        email,
        "重置你的 SiliEvo 密码",
        "点击重置密码",
        resetUrl
      );
      if (!result.delivered) {
        console.error("[密码重置] 邮件未成功发送，可能 SMTP 未配置");
      }
    } catch (mailErr) {
      console.error("发送密码重置邮件失败:", mailErr);
      res.status(500).json({ error: "邮件发送失败，请稍后重试" });
      return;
    }

    res.json({ message: "重置链接已发送至邮箱，请查收" });
  }
);

// ============================================
// 重置密码（通过令牌）
// ============================================
router.post(
  "/forgot-password/reset",
  [
    body("token").isString().notEmpty().withMessage("缺少重置令牌"),
    body("password").custom(passwordComplexity),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const { token, password } = req.body;

    // 验证令牌
    const userId = await consumeOneTimeToken({
      scope: "pwd_reset",
      token,
    });

    if (!userId) {
      res.status(400).json({ error: "重置链接无效或已过期" });
      return;
    }

    const user = await UserService.findById(userId);
    if (!user) {
      res.status(400).json({ error: "用户不存在" });
      return;
    }

    // 更新密码
    await UserService.updatePassword(user.id, password);
    await revokeRefreshToken(user.id);

    res.json({ message: "密码重置成功，请重新登录" });
  }
);

// ============================================
// 手机号绑定：发送短信验证码（开发期打印到控制台）
// ============================================
router.post(
  "/send-bind-sms",
  authMiddleware,
  [body("phone").matches(/^1[3-9]\d{9}$/).withMessage("请输入有效的手机号")],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const userId = req.user!.userId;
    const { phone } = req.body as { phone: string };

    try {
      // 1. 防刷：同一用户 60 秒只能发一次
      const cooldownKey = `bind_sms_cd:${userId}`;
      const cd = await redis.get(cooldownKey);
      if (cd) {
        res.status(429).json({ error: `请 ${cd} 秒后再试` });
        return;
      }

      // 2. 防同号被多人绑定
      const existing = await UserService.findByPhone(phone);
      if (existing && existing.id !== userId) {
        res.status(409).json({ error: "该手机号已被其他账号绑定" });
        return;
      }

      // 3. 生成 6 位验证码
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeKey = `bind_sms:${userId}:${phone}`;
      // TTL 5 分钟
      await redis.setex(codeKey, 5 * 60, code);
      // 60 秒冷却（值就是剩余秒数，方便 GET 拿到）
      await redis.setex(cooldownKey, 60, "60");

      // 4. 真实环境对接短信平台；开发期打印到后端控制台
      console.log(
        `\n📱 [DEV-SMS] userId=${userId} phone=${phone} code=${code}（5 分钟内有效）\n`
      );

      const isDev = process.env.NODE_ENV !== "production";
      res.json({
        message: "验证码已发送",
        ...(isDev ? { devCode: code } : {}), // 仅开发环境返回，方便联调
      });
    } catch (err) {
      console.error("send-bind-sms error:", err);
      res.status(500).json({ error: "发送失败，请稍后重试" });
    }
  }
);

// ============================================
// 手机号绑定：校验验证码并写入 user_users.phone
// ============================================
router.post(
  "/bind-phone",
  authMiddleware,
  [
    body("phone").matches(/^1[3-9]\d{9}$/).withMessage("请输入有效的手机号"),
    body("code").matches(/^\d{6}$/).withMessage("验证码格式错误"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    const userId = req.user!.userId;
    const { phone, code } = req.body as { phone: string; code: string };

    try {
      const codeKey = `bind_sms:${userId}:${phone}`;
      const stored = await redis.get(codeKey);
      if (!stored) {
        res.status(400).json({ error: "验证码已过期，请重新发送" });
        return;
      }
      if (stored !== code) {
        res.status(400).json({ error: "验证码错误" });
        return;
      }

      // 再次确认手机号未被他人占用（防并发）
      const existing = await UserService.findByPhone(phone);
      if (existing && existing.id !== userId) {
        res.status(409).json({ error: "该手机号已被其他账号绑定" });
        return;
      }

      await UserService.bindPhone(userId, phone);
      await redis.del(codeKey);

      const fresh = await UserService.findById(userId);
      res.json({
        message: "绑定成功",
        user: fresh ? getPublicUser(fresh) : null,
      });
    } catch (err: any) {
      console.error("bind-phone error:", err);
      if (err?.code === "ER_DUP_ENTRY") {
        res.status(409).json({ error: "该手机号已被其他账号绑定" });
        return;
      }
      res.status(500).json({ error: "绑定失败，请稍后重试" });
    }
  }
);

// ============================================
// 占位：手机号登录 / OAuth 登录 (P2 阶段实现)
// ============================================
router.post("/login-phone", (_req, res) => {
  res.status(501).json({ error: "手机号登录尚未开放，请使用邮箱登录" });
});
router.post("/login-wechat", (_req, res) => {
  res.status(501).json({ error: "微信登录尚未开放" });
});
router.post("/login-alipay", (_req, res) => {
  res.status(501).json({ error: "支付宝登录尚未开放" });
});

export default router;

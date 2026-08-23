/**
 * 短信验证码相关路由
 *
 *   POST /api/sms/send-code     发送验证码
 *   POST /api/sms/phone-login   手机号+验证码登录 / 首次自动注册
 *   POST /api/sms/bind-phone    给已登录账号绑手机号
 *   POST /api/sms/unbind-phone  解绑手机号
 *
 * 注意：本路由全部走 MySQL（UserService），不依赖 Prisma。
 */

import { Router, Request, Response } from "express";
import { body, validationResult } from "express-validator";
import { authMiddleware } from "../middleware/auth";
import { sendSmsCode, verifyCode, generateCode } from "../utils/sms";
import UserService, { getPublicUser } from "../services/UserService";
import { issueAuthSession } from "../utils/auth-session-mysql";
import pool from "../db/mysql";

const router = Router();

// ==================== 发送验证码 ====================
router.post(
  "/send-code",
  [
    body("phone")
      .trim()
      .matches(/^1[3-9]\d{9}$/)
      .withMessage("请输入有效的手机号"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const { phone } = req.body;

    try {
      const code = generateCode();
      const success = await sendSmsCode(phone, code);

      // 短信通道未配置时降级到 dev 模式：码已写 Redis，前端继续走流程即可
      if (success) {
        res.json({ message: "验证码已发送", expiresIn: 300 });
      } else {
        res.json({ message: "验证码已发送", expiresIn: 300, devMode: true });
      }
    } catch (error: any) {
      console.error("Send code error:", error);
      // 频率限制等业务错误：sendSmsCode 抛 Error("发送太频繁...")
      if (error?.message?.includes("60秒")) {
        res.status(429).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "发送验证码失败，请稍后重试" });
    }
  }
);

// ==================== 手机号 + 验证码登录（首次自动注册） ====================
router.post(
  "/phone-login",
  [
    body("phone")
      .trim()
      .matches(/^1[3-9]\d{9}$/)
      .withMessage("请输入有效的手机号"),
    body("code").isLength({ min: 6, max: 6 }).withMessage("请输入6位验证码"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const { phone, code, inviteCode } = req.body;

    try {
      const valid = await verifyCode(phone, code);
      if (!valid) {
        res.status(400).json({ error: "验证码错误或已过期" });
        return;
      }

      let user = await UserService.findByPhone(phone);
      let isNewUser = false;

      if (!user) {
        // 首次手机号登录 → 自动建账号
        // 处理邀请码（如果有）
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

        const { userId } = await UserService.createPhoneUser({ phone, invitedBy });
        user = await UserService.findById(userId);
        isNewUser = true;

        // 创建邀请关系记录（仅当邀请码有效时）
        if (invitedBy && useInviteCode && user) {
          try {
            await pool.execute(
              "INSERT INTO user_invites (inviter_id, invitee_id, invite_code, status, registered_at, created_at) VALUES (?, ?, ?, 'registered', NOW(), NOW())",
              [invitedBy, userId, useInviteCode]
            );
          } catch (err) {
            // 邀请记录创建失败不影响主流程
            console.error("创建邀请记录失败（已忽略）:", err);
          }
        }
      }

      if (!user) {
        res.status(500).json({ error: "账号创建失败" });
        return;
      }

      const { accessToken } = await issueAuthSession(user, res);

      res.json({
        token: accessToken,
        user: getPublicUser(user),
        isNewUser,
      });
    } catch (error) {
      console.error("Phone login error:", error);
      res.status(500).json({ error: "登录失败，请稍后重试" });
    }
  }
);

// ==================== 绑定手机号（需登录） ====================
router.post(
  "/bind-phone",
  authMiddleware,
  [
    body("phone")
      .trim()
      .matches(/^1[3-9]\d{9}$/)
      .withMessage("请输入有效的手机号"),
    body("code").isLength({ min: 6, max: 6 }).withMessage("请输入6位验证码"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }

    const { phone, code } = req.body;

    try {
      const valid = await verifyCode(phone, code);
      if (!valid) {
        res.status(400).json({ error: "验证码错误或已过期" });
        return;
      }

      // 检查手机号是否已被其他人绑定
      const owner = await UserService.findByPhone(phone);
      if (owner && owner.id !== req.user!.userId) {
        res.status(400).json({ error: "该手机号已被其他账号绑定" });
        return;
      }

      await UserService.bindPhone(req.user!.userId, phone);
      const fresh = await UserService.findById(req.user!.userId);

      res.json({
        message: "手机号绑定成功",
        user: fresh ? getPublicUser(fresh) : null,
      });
    } catch (error) {
      console.error("Bind phone error:", error);
      res.status(500).json({ error: "绑定失败，请稍后重试" });
    }
  }
);

// ==================== 解绑手机号（需登录） ====================
router.post(
  "/unbind-phone",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      await UserService.unbindPhone(req.user!.userId);
      const fresh = await UserService.findById(req.user!.userId);

      res.json({
        message: "手机号已解绑",
        user: fresh ? getPublicUser(fresh) : null,
      });
    } catch (error) {
      console.error("Unbind phone error:", error);
      res.status(500).json({ error: "解绑失败，请稍后重试" });
    }
  }
);

export default router;

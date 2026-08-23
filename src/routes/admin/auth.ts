/**
 * 管理端认证（挂载 /api/admin/auth）
 *
 *   POST /login     管理员登录（pt_admins，bcrypt 校验）→ 返回管理 JWT
 *   GET  /me        当前管理员信息
 *   POST /logout    登出（前端丢弃 token）
 *   POST /password  修改自己密码（旧+新）
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { cpQuery } from "../../config/db";
import { adminAuth, generateAdminToken } from "../../middlewares/adminAuth";
import { verifyTurnstile, clientIp } from "../../utils/turnstile";

const router = Router();

router.post("/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "用户名和密码必填" });
      return;
    }

    // Cloudflare Turnstile 人机验证（防密码爆破；未配置 secret 时放行）
    const captchaResult = await verifyTurnstile(
      req.body?.captchaToken,
      clientIp(req)
    );
    if (!captchaResult.success) {
      res.status(400).json({ error: captchaResult.error || "人机验证未通过，请刷新后重试" });
      return;
    }

    const rows = await cpQuery(
      "SELECT * FROM pt_admins WHERE username = ? AND status = 'ACTIVE' LIMIT 1",
      [username]
    );
    const admin = Array.isArray(rows) ? rows[0] : null;
    if (!admin) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }

    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }

    await cpQuery("UPDATE pt_admins SET last_login_at = NOW() WHERE id = ?", [admin.id]);

    const token = generateAdminToken({
      adminId: admin.id,
      username: admin.username,
      role: admin.role,
    });

    res.json({
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
      },
    });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ error: "登录失败" });
  }
});

router.get("/me", adminAuth, (req: Request, res: Response) => {
  res.json({ admin: req.admin });
});

router.post("/logout", adminAuth, (_req: Request, res: Response) => {
  // 管理端 JWT 无状态，前端丢弃 token 即可
  res.json({ success: true });
});

router.post("/password", adminAuth, async (req: Request, res: Response) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      res.status(400).json({ error: "旧密码和新密码必填" });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: "新密码至少 8 位" });
      return;
    }

    const rows = await cpQuery("SELECT * FROM pt_admins WHERE id = ? LIMIT 1", [req.admin!.adminId]);
    const admin = Array.isArray(rows) ? rows[0] : null;
    if (!admin) {
      res.status(404).json({ error: "管理员不存在" });
      return;
    }
    const ok = await bcrypt.compare(oldPassword, admin.password_hash);
    if (!ok) {
      res.status(400).json({ error: "旧密码不正确" });
      return;
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await cpQuery("UPDATE pt_admins SET password_hash = ? WHERE id = ?", [hash, admin.id]);
    res.json({ success: true, message: "密码已更新" });
  } catch (err) {
    console.error("Admin password error:", err);
    res.status(500).json({ error: "修改密码失败" });
  }
});

export default router;

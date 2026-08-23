/**
 * 用户 API Token 管理路由（挂载在 /api/tokens 下）
 *
 *   GET    /              列出当前用户的 token（脱敏）
 *   POST   /              创建新 token；返回**完整明文 key**（仅此一次场景，但本系统也允许后续 reveal）
 *   GET    /:id/reveal    返回完整 key（用于"复制"）
 *   PATCH  /:id/status    启用 / 禁用
 *   DELETE /:id           删除
 */

import { Router, Request, Response } from "express";
import { body, param, validationResult } from "express-validator";
import TokenService, { getPublicToken } from "../services/TokenService";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.use(authMiddleware);

// 列表
router.get("/", async (req: Request, res: Response) => {
  try {
    const rows = await TokenService.listByUser(req.user!.userId);
    res.json({ tokens: rows.map(getPublicToken) });
  } catch (err) {
    console.error("List tokens error:", err);
    res.status(500).json({ error: "获取 Token 列表失败" });
  }
});

// 创建
router.post(
  "/",
  [
    body("name")
      .isString()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Token 名称必须 1-100 字符"),
    body("expiredAt")
      .optional({ nullable: true })
      .isISO8601()
      .withMessage("有效期格式错误"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    try {
      const row = await TokenService.create({
        userId: req.user!.userId,
        name: req.body.name,
        expiredAt: req.body.expiredAt ? new Date(req.body.expiredAt) : null,
      });
      // 创建时返回完整 key（前端用来一次性显示 + 自动复制）
      res.status(201).json({
        token: { ...getPublicToken(row), key: row.key },
      });
    } catch (err: any) {
      console.error("Create token error:", err);
      if (err?.code === "ER_DUP_ENTRY") {
        // 极小概率：随机 key 冲突 —— 让前端重试
        res.status(500).json({ error: "Token 生成冲突，请重试" });
        return;
      }
      res.status(500).json({ error: err.message || "创建 Token 失败" });
    }
  }
);

// 揭示完整 key（用于"复制到剪贴板"）
router.get(
  "/:id/reveal",
  [param("id").isInt().toInt()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: "参数错误" });
      return;
    }
    try {
      const row = await TokenService.findById(
        Number(req.params.id),
        req.user!.userId
      );
      if (!row) {
        res.status(404).json({ error: "Token 不存在" });
        return;
      }
      res.json({ key: row.key });
    } catch (err) {
      console.error("Reveal token error:", err);
      res.status(500).json({ error: "获取 Token 失败" });
    }
  }
);

// 改名
router.patch(
  "/:id/name",
  [
    param("id").isInt().toInt(),
    body("name")
      .isString()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("名称必须 1-100 字符"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: errors.array()[0].msg });
      return;
    }
    try {
      const ok = await TokenService.rename(
        Number(req.params.id),
        req.user!.userId,
        req.body.name
      );
      if (!ok) {
        res.status(404).json({ error: "Token 不存在或不可修改" });
        return;
      }
      res.json({ message: "已更新" });
    } catch (err) {
      console.error("Rename token error:", err);
      res.status(500).json({ error: "更新失败" });
    }
  }
);

// 启用 / 禁用
router.patch(
  "/:id/status",
  [
    param("id").isInt().toInt(),
    body("enabled").isBoolean(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: "参数错误" });
      return;
    }
    try {
      const ok = await TokenService.setStatus(
        Number(req.params.id),
        req.user!.userId,
        Boolean(req.body.enabled)
      );
      if (!ok) {
        res.status(404).json({ error: "Token 不存在或不可修改" });
        return;
      }
      res.json({ message: "已更新" });
    } catch (err) {
      console.error("Set token status error:", err);
      res.status(500).json({ error: "更新失败" });
    }
  }
);

// 删除
router.delete(
  "/:id",
  [param("id").isInt().toInt()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ error: "参数错误" });
      return;
    }
    try {
      const result = await TokenService.delete(
        Number(req.params.id),
        req.user!.userId
      );
      if (!result.success) {
        res.status(400).json({ error: result.error || "删除失败" });
        return;
      }
      res.json({ message: "已删除" });
    } catch (err) {
      console.error("Delete token error:", err);
      res.status(500).json({ error: "删除失败" });
    }
  }
);

export default router;

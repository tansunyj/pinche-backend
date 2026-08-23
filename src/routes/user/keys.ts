/**
 * API Key 管理（挂载 /api/user/keys，融合自老 tokens.ts）
 *
 *   GET    /              列出当前用户的 Key（脱敏）
 *   POST   /              创建新 Key；返回完整明文 key
 *   GET    /:id/reveal    返回完整 key（复制用）
 *   PATCH  /:id/name      改名
 *   PATCH  /:id/status    启用/禁用
 *   DELETE /:id           删除（不返还剩余额度）
 */

import { Router, Request, Response } from "express";
import { body, param, validationResult } from "express-validator";
import TokenService, { getPublicToken } from "../../services/token";
import { userAuth } from "../../middlewares/userAuth";

const router = Router();
router.use(userAuth);

router.get("/", async (req: Request, res: Response) => {
  try {
    const rows = await TokenService.listByUser(req.user!.userId);
    res.json({ keys: rows.map(getPublicToken) });
  } catch (err) {
    console.error("List keys error:", err);
    res.status(500).json({ error: "获取 Key 列表失败" });
  }
});

router.post(
  "/",
  [
    body("name").isString().trim().isLength({ min: 1, max: 100 }).withMessage("Key 名称必须 1-100 字符"),
    body("expiredAt").optional({ nullable: true }).isISO8601().withMessage("有效期格式错误"),
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
      res.status(201).json({ key: { ...getPublicToken(row), key: row.key } });
    } catch (err: any) {
      console.error("Create key error:", err);
      res.status(500).json({ error: err?.message || "创建 Key 失败" });
    }
  }
);

router.get(
  "/:id/reveal",
  [param("id").isInt().toInt()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) { res.status(400).json({ error: "参数错误" }); return; }
    try {
      const row = await TokenService.findById(Number(req.params.id), req.user!.userId);
      if (!row) { res.status(404).json({ error: "Key 不存在" }); return; }
      res.json({ key: row.key });
    } catch {
      res.status(500).json({ error: "获取 Key 失败" });
    }
  }
);

router.patch(
  "/:id/name",
  [
    param("id").isInt().toInt(),
    body("name").isString().trim().isLength({ min: 1, max: 100 }).withMessage("名称必须 1-100 字符"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) { res.status(400).json({ error: errors.array()[0].msg }); return; }
    try {
      const ok = await TokenService.rename(Number(req.params.id), req.user!.userId, req.body.name);
      if (!ok) { res.status(404).json({ error: "Key 不存在或不可修改" }); return; }
      res.json({ message: "已更新" });
    } catch {
      res.status(500).json({ error: "更新失败" });
    }
  }
);

router.patch(
  "/:id/status",
  [param("id").isInt().toInt(), body("enabled").isBoolean()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) { res.status(400).json({ error: "参数错误" }); return; }
    try {
      const ok = await TokenService.setStatus(Number(req.params.id), req.user!.userId, Boolean(req.body.enabled));
      if (!ok) { res.status(404).json({ error: "Key 不存在或不可修改" }); return; }
      res.json({ message: "已更新" });
    } catch {
      res.status(500).json({ error: "更新失败" });
    }
  }
);

router.delete(
  "/:id",
  [param("id").isInt().toInt()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) { res.status(400).json({ error: "参数错误" }); return; }
    try {
      const result = await TokenService.delete(Number(req.params.id), req.user!.userId);
      if (!result.success) { res.status(400).json({ error: result.error || "删除失败" }); return; }
      res.json({ message: "已删除" });
    } catch {
      res.status(500).json({ error: "删除失败" });
    }
  }
);

export default router;

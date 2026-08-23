/**
 * 管理端充值档位 CRUD（挂载 /api/admin/tiers）
 *
 *   GET    /      档位列表
 *   POST   /      创建档位（仅超管）
 *   PUT    /:id   更新档位（仅超管）
 *   DELETE /:id   下架档位（软删 enabled=false，仅超管）
 */

import { Router, Request, Response } from "express";
import { cpQuery } from "../../config/db";
import { adminAuth, requireSuperAdmin } from "../../middlewares/adminAuth";

const router = Router();
router.use(adminAuth);

router.get("/", async (_req: Request, res: Response) => {
  try {
    const rows = await cpQuery("SELECT * FROM pt_recharge_tiers ORDER BY display_order ASC, id ASC");
    res.json({ tiers: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error("Admin tiers list error:", err);
    res.status(500).json({ error: "获取档位失败" });
  }
});

router.post("/", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const amountYuan = Number(req.body?.amountYuan);
    const quota = Number(req.body?.quota);
    const displayOrder = Number(req.body?.displayOrder || 0);
    if (!(amountYuan > 0) || !(quota > 0)) {
      res.status(400).json({ error: "金额和额度必须大于 0" });
      return;
    }
    const [r] = await cpQuery(
      "INSERT INTO pt_recharge_tiers (amount_yuan, quota, display_order, enabled) VALUES (?, ?, ?, TRUE)",
      [amountYuan, quota, displayOrder]
    );
    res.json({ success: true, id: (r as any).insertId, message: "档位已创建" });
  } catch (err) {
    console.error("Admin tier create error:", err);
    res.status(500).json({ error: "创建档位失败" });
  }
});

router.put("/:id", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { amountYuan, quota, displayOrder, enabled } = req.body || {};
    const sets: string[] = [];
    const params: any[] = [];
    if (amountYuan !== undefined) { sets.push("amount_yuan = ?"); params.push(Number(amountYuan)); }
    if (quota !== undefined) { sets.push("quota = ?"); params.push(Number(quota)); }
    if (displayOrder !== undefined) { sets.push("display_order = ?"); params.push(Number(displayOrder)); }
    if (enabled !== undefined) { sets.push("enabled = ?"); params.push(!!enabled); }
    if (sets.length === 0) {
      res.status(400).json({ error: "无更新字段" });
      return;
    }
    params.push(req.params.id);
    const [ur] = await cpQuery(`UPDATE pt_recharge_tiers SET ${sets.join(", ")} WHERE id = ?`, params);
    if ((ur as any).affectedRows === 0) {
      res.status(404).json({ error: "档位不存在" });
      return;
    }
    res.json({ success: true, message: "档位已更新" });
  } catch (err) {
    console.error("Admin tier update error:", err);
    res.status(500).json({ error: "更新档位失败" });
  }
});

router.delete("/:id", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const [ur] = await cpQuery("UPDATE pt_recharge_tiers SET enabled = FALSE WHERE id = ?", [req.params.id]);
    if ((ur as any).affectedRows === 0) {
      res.status(404).json({ error: "档位不存在" });
      return;
    }
    res.json({ success: true, message: "档位已下架" });
  } catch (err) {
    console.error("Admin tier delete error:", err);
    res.status(500).json({ error: "下架档位失败" });
  }
});

export default router;

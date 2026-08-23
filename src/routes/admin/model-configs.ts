/**
 * 管理端端点模板管理（挂载 /api/admin/model-configs）
 *
 *   GET    /model-templates          端点模板列表
 *   POST   /model-templates          创建（endpoint_name + path 必填）
 *   PUT    /model-templates/:id      更新
 *   DELETE /model-templates/:id      物理删除（表已无 status 列）
 *
 * 注：model_channel_configs 表已废弃删除，此处仅保留基于 endpoint 表的端点模板管理；
 *     模型调用 URI 的绑定/覆盖逻辑由网关侧自行解析。
 */

import { Router, Request, Response } from "express";
import { gatewayPool } from "../../config/db";
import { adminAuth } from "../../middlewares/adminAuth";

const router = Router();
router.use(adminAuth);

// ============ 端点模板列表 ============
router.get("/model-templates", async (_req: Request, res: Response) => {
  try {
    const [rows] = await gatewayPool.execute(
      `SELECT id, endpoint_name, path FROM endpoint ORDER BY id DESC`
    );
    res.json({ templates: rows as any[] });
  } catch (err) {
    console.error("[model-configs] templates error:", err);
    res.status(500).json({ error: "获取模板列表失败" });
  }
});

// ============ 创建端点模板 ============
router.post("/model-templates", async (req: Request, res: Response) => {
  const { endpoint_name, path } = req.body || {};

  if (!endpoint_name || !path) {
    res.status(400).json({ error: "endpoint_name、path 为必填项" });
    return;
  }

  try {
    const [r] = await gatewayPool.execute(
      `INSERT INTO endpoint (endpoint_name, path) VALUES (?, ?)`,
      [endpoint_name, path]
    );
    res.json({ success: true, id: (r as any).insertId, message: "端点模板已创建" });
  } catch (err) {
    console.error("[model-configs] template create error:", err);
    res.status(500).json({ error: "创建端点模板失败" });
  }
});

// ============ 更新端点模板 ============
router.put("/model-templates/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { endpoint_name, path } = req.body || {};

  try {
    const sets: string[] = [];
    const params: any[] = [];
    if (endpoint_name !== undefined) { sets.push("endpoint_name = ?"); params.push(endpoint_name); }
    if (path !== undefined) { sets.push("path = ?"); params.push(path); }

    if (sets.length === 0) {
      res.status(400).json({ error: "无更新字段" });
      return;
    }
    params.push(id);
    const [r] = await gatewayPool.execute(
      `UPDATE endpoint SET ${sets.join(", ")} WHERE id = ?`,
      params
    );
    if ((r as any).affectedRows === 0) {
      res.status(404).json({ error: "端点模板不存在" });
      return;
    }
    res.json({ success: true, message: "端点模板已更新" });
  } catch (err) {
    console.error("[model-configs] template update error:", err);
    res.status(500).json({ error: "更新端点模板失败" });
  }
});

// ============ 删除端点模板（物理删除） ============
router.delete("/model-templates/:id", async (req: Request, res: Response) => {
  try {
    const [r] = await gatewayPool.execute(
      "DELETE FROM endpoint WHERE id = ?",
      [req.params.id]
    );
    if ((r as any).affectedRows === 0) {
      res.status(404).json({ error: "端点模板不存在" });
      return;
    }
    res.json({ success: true, message: "端点模板已删除" });
  } catch (err) {
    console.error("[model-configs] template delete error:", err);
    res.status(500).json({ error: "删除端点模板失败" });
  }
});

export default router;

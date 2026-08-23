/**
 * 管理端模型库（挂载 /api/admin/models）
 *
 *   GET    /                   分页模型库列表（支持 search / status / category 过滤）
 *   POST   /                   新增模型（model_id / display_name / category / provider 必填）
 *   PUT    /:modelId           更新模型
 *   DELETE /:modelId           删除模型（model_prices 外键 CASCADE 级联清理）
 *
 * 业务逻辑移植自 admin_backend/routes/marketplace.js（TS 化，adminAuth + gatewayPool）。
 */

import { Router, Request, Response } from "express";
import { gatewayPool } from "../../config/db";
import { adminAuth } from "../../middlewares/adminAuth";

const router = Router();
router.use(adminAuth);

const EDITABLE = [
  "display_name", "description", "category", "provider",
  "context_window", "max_output_tokens", "training_data_cutoff",
  "status", "is_visible", "is_hot", "is_new", "badge_text", "badge_color",
  "sort_order", "icon_url", "doc_url",
];

function shapeRow(m: any) {
  return {
    id: m.id,
    modelId: m.model_id,
    displayName: m.display_name,
    description: m.description,
    category: m.category,
    provider: m.provider,
    contextWindow: m.context_window,
    maxOutputTokens: m.max_output_tokens,
    trainingDataCutoff: m.training_data_cutoff,
    status: m.status,
    isVisible: m.is_visible,
    isHot: m.is_hot,
    isNew: m.is_new,
    badgeText: m.badge_text,
    badgeColor: m.badge_color,
    sortOrder: m.sort_order,
    iconUrl: m.icon_url,
    docUrl: m.doc_url,
    createdAt: m.created_at,
  };
}

// ============ 模型库列表 ============
router.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "50"), 10)));
    const search = String(req.query.search || "").trim();
    const category = String(req.query.category || "").trim();
    const status = String(req.query.status || "").trim();
    const offset = (page - 1) * pageSize;

    const conds: string[] = [];
    const params: any[] = [];
    if (search) {
      conds.push("(model_id LIKE ? OR display_name LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }
    if (category) {
      conds.push("category = ?");
      params.push(category);
    }
    if (status === "1" || status === "0") {
      conds.push("status = ?");
      params.push(Number(status));
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const [cntRows] = await gatewayPool.execute(`SELECT COUNT(*) AS cnt FROM model_library ${where}`, params);
    const total = Number((cntRows as any[])[0]?.cnt || 0);

    const [rows] = await gatewayPool.execute(
      `SELECT * FROM model_library ${where} ORDER BY sort_order ASC, id ASC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    // 模型库去重获取可选 category
    const [catRows] = await gatewayPool.execute(
      `SELECT DISTINCT category FROM model_library WHERE category IS NOT NULL AND category <> '' ORDER BY category ASC`
    );

    res.json({
      total,
      page,
      pageSize,
      categories: (catRows as any[]).map((c) => c.category),
      models: (rows as any[]).map(shapeRow),
    });
  } catch (err) {
    console.error("Admin models list error:", err);
    res.status(500).json({ error: "获取模型列表失败" });
  }
});

// ============ 新增模型 ============
router.post("/", async (req: Request, res: Response) => {
  const b = req.body || {};
  const required = ["model_id", "display_name", "category", "provider"];
  for (const k of required) {
    if (!b[k]) {
      res.status(400).json({ error: `${k} 为必填项` });
      return;
    }
  }

  try {
    const [r] = await gatewayPool.execute(
      `INSERT INTO model_library
         (model_id, display_name, description, category, provider, capabilities,
          context_window, max_output_tokens, training_data_cutoff, status, is_visible,
          is_hot, is_new, badge_text, badge_color, sort_order, icon_url, doc_url, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.model_id, b.display_name, b.description ?? null, b.category, b.provider,
        b.capabilities ? JSON.stringify(b.capabilities) : null,
        b.context_window ?? null, b.max_output_tokens ?? null, b.training_data_cutoff ?? null,
        b.status ?? 1, b.is_visible ?? 1,
        b.is_hot ? 1 : 0, b.is_new ? 1 : 0,
        b.badge_text ?? null, b.badge_color ?? null,
        b.sort_order ?? 0, b.icon_url ?? null, b.doc_url ?? null,
        b.metadata ? JSON.stringify(b.metadata) : null,
      ]
    );
    res.json({ success: true, id: (r as any).insertId, modelId: b.model_id, message: "模型创建成功" });
  } catch (err: any) {
    console.error("Admin model create error:", err);
    if (err?.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: "model_id 已存在，请使用其他模型标识" });
      return;
    }
    res.status(500).json({ error: "创建模型失败" });
  }
});

// ============ 更新模型 ============
router.put("/:modelId", async (req: Request, res: Response) => {
  const { modelId } = req.params;
  const b = req.body || {};
  const sets: string[] = [];
  const params: any[] = [];
  for (const f of EDITABLE) {
    if (b[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(b[f]);
    }
  }
  if (b.capabilities !== undefined) {
    sets.push("capabilities = ?");
    params.push(b.capabilities ? JSON.stringify(b.capabilities) : null);
  }
  if (b.metadata !== undefined) {
    sets.push("metadata = ?");
    params.push(b.metadata ? JSON.stringify(b.metadata) : null);
  }
  if (sets.length === 0) {
    res.status(400).json({ error: "无更新字段" });
    return;
  }

  try {
    params.push(modelId);
    const [r] = await gatewayPool.execute(`UPDATE model_library SET ${sets.join(", ")} WHERE model_id = ?`, params);
    if ((r as any).affectedRows === 0) {
      res.status(404).json({ error: "模型不存在" });
      return;
    }
    res.json({ success: true, message: "模型更新成功" });
  } catch (err) {
    console.error("Admin model update error:", err);
    res.status(500).json({ error: "更新模型失败" });
  }
});

// ============ 删除模型 ============
router.delete("/:modelId", async (req: Request, res: Response) => {
  const { modelId } = req.params;
  try {
    // model_prices / model_endpoints 均设 ON DELETE CASCADE，直接删除
    const [r] = await gatewayPool.execute("DELETE FROM model_library WHERE model_id = ?", [modelId]);
    if ((r as any).affectedRows === 0) {
      res.status(404).json({ error: "模型不存在" });
      return;
    }
    res.json({ success: true, message: "模型删除成功" });
  } catch (err) {
    console.error("Admin model delete error:", err);
    res.status(500).json({ error: "删除模型失败" });
  }
});

export default router;

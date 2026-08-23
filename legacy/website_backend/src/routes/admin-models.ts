import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";

const router = Router();

type PricingUnit = "per_1k_tokens" | "per_1m_tokens";

function normalizePricingUnit(unit?: string): PricingUnit {
  return unit === "per_1m_tokens" ? "per_1m_tokens" : "per_1k_tokens";
}

function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatLegacyPrice(amount: number | null, unit: PricingUnit, currency = "CNY") {
  if (amount === null) return "";
  const symbol = currency === "USD" ? "$" : "¥";
  const normalized = amount < 1 ? amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${symbol}${normalized}/${unit === "per_1m_tokens" ? "1M" : "1K"}`;
}

function toAdminModel(model: any) {
  return {
    ...model,
    effectivePrice: model.sale_price ?? model.official_price ?? null,
  };
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
}

router.use(authMiddleware, requireAdmin);

router.get("/", async (req: Request, res: Response) => {
  try {
    const { status, region, q } = req.query;
    const conditions: string[] = [];
    const params: any[] = [];

    if (status && status !== "all") {
      conditions.push('status = ?');
      params.push(String(status));
    }
    if (region && region !== "全部") {
      conditions.push('region = ?');
      params.push(String(region));
    }
    if (q) {
      conditions.push('(name LIKE ? OR provider LIKE ? OR type LIKE ?)');
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [models] = await pool.execute(
      `SELECT * FROM model ${whereClause} ORDER BY sort_order DESC, updated_at DESC`,
      params
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM model ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: {
        models: (models as any[]).map(toAdminModel),
        total: (countRows as any[])[0]?.total || 0,
      },
    });
  } catch (error) {
    console.error("Admin list models error:", error);
    res.status(500).json({ success: false, error: "获取模型管理列表失败" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM model WHERE id = ?',
      [req.params.id]
    );
    const model = (rows as any[])[0];
    if (!model) {
      res.status(404).json({ success: false, error: "模型不存在" });
      return;
    }

    res.json({ success: true, data: toAdminModel(model) });
  } catch (error) {
    console.error("Admin get model error:", error);
    res.status(500).json({ success: false, error: "获取模型详情失败" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      name,
      provider,
      type,
      description,
      params,
      context,
      region,
      serverAddress,
      status,
      officialPrice,
      salePrice,
      currency,
      pricingUnit,
      sortOrder,
      popular,
      recommended,
    } = req.body ?? {};

    if (!name || !provider || !type || !description) {
      res.status(400).json({ success: false, error: "名称、供应商、类型和描述不能为空" });
      return;
    }

    const id = generateId();
    const normalizedUnit = normalizePricingUnit(pricingUnit);
    const normalizedOfficialPrice = parseOptionalNumber(officialPrice);
    const normalizedSalePrice = parseOptionalNumber(salePrice);
    const effectivePrice = normalizedSalePrice ?? normalizedOfficialPrice;

    await pool.execute(
      `INSERT INTO model (
        id, name, provider, type, description, params, context, price,
        popular, recommended, region, server_address, status,
        official_price, sale_price, currency, pricing_unit, sort_order, published_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id,
        String(name),
        String(provider),
        String(type),
        String(description),
        String(params || ""),
        String(context || ""),
        formatLegacyPrice(effectivePrice, normalizedUnit, String(currency || "CNY")),
        Boolean(popular),
        Boolean(recommended),
        String(region || "国内"),
        serverAddress ? String(serverAddress) : null,
        status === "active" ? "active" : "draft",
        normalizedOfficialPrice,
        normalizedSalePrice,
        String(currency || "CNY"),
        normalizedUnit,
        Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
        status === "active" ? new Date() : null,
      ]
    );

    const [newRows] = await pool.execute('SELECT * FROM model WHERE id = ?', [id]);
    res.status(201).json({ success: true, data: toAdminModel((newRows as any[])[0]) });
  } catch (error: any) {
    console.error("Admin create model error:", error);
    const message = error?.code === "ER_DUP_ENTRY" ? "模型名称已存在" : "创建模型失败";
    res.status(500).json({ success: false, error: message });
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const [existingRows] = await pool.execute('SELECT * FROM model WHERE id = ?', [req.params.id]);
    const existing = (existingRows as any[])[0];
    if (!existing) {
      res.status(404).json({ success: false, error: "模型不存在" });
      return;
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (req.body?.name !== undefined) {
      updates.push('name = ?');
      values.push(String(req.body.name));
    }
    if (req.body?.provider !== undefined) {
      updates.push('provider = ?');
      values.push(String(req.body.provider));
    }
    if (req.body?.type !== undefined) {
      updates.push('type = ?');
      values.push(String(req.body.type));
    }
    if (req.body?.description !== undefined) {
      updates.push('description = ?');
      values.push(String(req.body.description));
    }
    if (req.body?.params !== undefined) {
      updates.push('params = ?');
      values.push(String(req.body.params));
    }
    if (req.body?.context !== undefined) {
      updates.push('context = ?');
      values.push(String(req.body.context));
    }
    if (req.body?.region !== undefined) {
      updates.push('region = ?');
      values.push(String(req.body.region));
    }
    if (req.body?.serverAddress !== undefined) {
      updates.push('server_address = ?');
      values.push(req.body.serverAddress ? String(req.body.serverAddress) : null);
    }
    if (req.body?.popular !== undefined) {
      updates.push('popular = ?');
      values.push(Boolean(req.body.popular));
    }
    if (req.body?.recommended !== undefined) {
      updates.push('recommended = ?');
      values.push(Boolean(req.body.recommended));
    }

    const normalizedStatus = req.body?.status ? String(req.body.status) : existing.status;
    if (req.body?.status !== undefined) {
      updates.push('status = ?');
      values.push(normalizedStatus);
    }

    const normalizedUnit = normalizePricingUnit(req.body?.pricingUnit || existing.pricing_unit);
    if (req.body?.pricingUnit !== undefined) {
      updates.push('pricing_unit = ?');
      values.push(normalizedUnit);
    }

    const normalizedOfficialPrice = req.body?.officialPrice !== undefined
      ? parseOptionalNumber(req.body.officialPrice)
      : existing.official_price;
    if (req.body?.officialPrice !== undefined) {
      updates.push('official_price = ?');
      values.push(normalizedOfficialPrice);
    }

    const normalizedSalePrice = req.body?.salePrice !== undefined
      ? parseOptionalNumber(req.body.salePrice)
      : existing.sale_price;
    if (req.body?.salePrice !== undefined) {
      updates.push('sale_price = ?');
      values.push(normalizedSalePrice);
    }

    const effectivePrice = normalizedSalePrice ?? normalizedOfficialPrice;
    const newCurrency = req.body?.currency !== undefined ? String(req.body.currency) : existing.currency;
    if (effectivePrice !== null) {
      updates.push('price = ?');
      values.push(formatLegacyPrice(effectivePrice, normalizedUnit, newCurrency));
    }

    if (req.body?.currency !== undefined) {
      updates.push('currency = ?');
      values.push(newCurrency);
    }

    if (req.body?.sortOrder !== undefined) {
      updates.push('sort_order = ?');
      values.push(Number(req.body.sortOrder) || 0);
    }

    if (normalizedStatus === "active") {
      if (!existing.published_at) {
        updates.push('published_at = ?');
        values.push(new Date());
      }
    } else if (req.body?.status === "archived" || req.body?.status === "draft") {
      updates.push('published_at = ?');
      values.push(null);
    }

    updates.push('updated_at = NOW()');

    if (updates.length > 0) {
      values.push(req.params.id);
      await pool.execute(
        `UPDATE model SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    }

    const [updatedRows] = await pool.execute('SELECT * FROM model WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: toAdminModel((updatedRows as any[])[0]) });
  } catch (error: any) {
    console.error("Admin update model error:", error);
    const message = error?.code === "ER_DUP_ENTRY" ? "模型名称已存在" : "更新模型失败";
    res.status(500).json({ success: false, error: message });
  }
});

router.patch("/:id/publish", async (req: Request, res: Response) => {
  try {
    await pool.execute(
      'UPDATE model SET status = ?, published_at = NOW(), updated_at = NOW() WHERE id = ?',
      ['active', req.params.id]
    );

    const [rows] = await pool.execute('SELECT * FROM model WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: toAdminModel((rows as any[])[0]) });
  } catch (error) {
    console.error("Admin publish model error:", error);
    res.status(500).json({ success: false, error: "模型上架失败" });
  }
});

router.patch("/:id/unpublish", async (req: Request, res: Response) => {
  try {
    await pool.execute(
      'UPDATE model SET status = ?, published_at = NULL, updated_at = NOW() WHERE id = ?',
      ['archived', req.params.id]
    );

    const [rows] = await pool.execute('SELECT * FROM model WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: toAdminModel((rows as any[])[0]) });
  } catch (error) {
    console.error("Admin unpublish model error:", error);
    res.status(500).json({ success: false, error: "模型下架失败" });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM model WHERE id = ?', [req.params.id]);
    const model = (rows as any[])[0];
    if (!model) {
      res.status(404).json({ success: false, error: "模型不存在" });
      return;
    }

    await pool.execute('DELETE FROM model WHERE id = ?', [req.params.id]);
    res.json({
      success: true,
      data: { id: req.params.id, name: model.name },
      message: "模型已删除",
    });
  } catch (error) {
    console.error("Admin delete model error:", error);
    res.status(500).json({ success: false, error: "删除模型失败" });
  }
});

export default router;

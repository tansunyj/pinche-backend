import { Router, Request, Response } from "express";
import pool from "../db/mysql";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";

const router = Router();

function parseLegacyPrice(price: string): number | null {
  const match = price.match(/[0-9.]+/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function inferPricingUnit(price: string): "per_1k_tokens" | "per_1m_tokens" {
  return /1m|1M|百万/i.test(price) ? "per_1m_tokens" : "per_1k_tokens";
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
}

const ALIBABA_MODELS = [
  { name: "Qwen-Max", provider: "阿里云百炼", type: "语言模型", description: "通义千问最强模型，适用于复杂推理、代码生成、长文本理解等高难度任务", params: "175B+", context: "32K", price: "¥0.02/1K", popular: true },
  { name: "Qwen-Max-0428", provider: "阿里云百炼", type: "语言模型", description: "Qwen Max 4月28日版本，增强数学和代码能力", params: "175B+", context: "32K", price: "¥0.02/1K", popular: false },
  { name: "Qwen-Plus", provider: "阿里云百炼", type: "语言模型", description: "通义千问高性价比模型，平衡能力与成本，适合大多数场景", params: "72B+", context: "128K", price: "¥0.008/1K", popular: true },
  { name: "Qwen-Plus-0628", provider: "阿里云百炼", type: "语言模型", description: "Qwen Plus 6月28日版本，长上下文增强", params: "72B+", context: "128K", price: "¥0.008/1K", popular: false },
  { name: "Qwen-Turbo", provider: "阿里云百炼", type: "语言模型", description: "通义千问极速模型，响应最快，适合实时对话和高并发场景", params: "14B+", context: "128K", price: "¥0.002/1K", popular: true },
  { name: "Qwen-Long", provider: "阿里云百炼", type: "语言模型", description: "超长上下文模型，支持1000万Token输入，适合长文档处理", params: "72B+", context: "10M", price: "¥0.0005/1K", popular: true },
  { name: "Qwen-VL-Max", provider: "阿里云百炼", type: "视觉模型", description: "通义千问视觉最强模型，支持图片理解、OCR、视频理解", params: "175B+", context: "32K", price: "¥0.02/1K", popular: true },
  { name: "Qwen-VL-Plus", provider: "阿里云百炼", type: "视觉模型", description: "通义千问视觉高性价比模型，图片理解和描述", params: "72B+", context: "32K", price: "¥0.008/1K", popular: false },
  { name: "Qwen-Audio", provider: "阿里云百炼", type: "语音模型", description: "通义千问语音模型，支持语音识别、语音理解", params: "72B+", context: "32K", price: "¥0.01/1K", popular: false },
  { name: "Qwen-Math", provider: "阿里云百炼", type: "语言模型", description: "数学专用模型，擅长数学推理和计算", params: "72B+", context: "32K", price: "¥0.008/1K", popular: false },
  { name: "Qwen-Coder", provider: "阿里云百炼", type: "语言模型", description: "代码专用模型，擅长代码生成、调试和解释", params: "72B+", context: "128K", price: "¥0.008/1K", popular: true },
  { name: "Qwen2.5-72B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 开源系列最强版本，指令遵循能力优秀", params: "72B", context: "128K", price: "¥0.004/1K", popular: false },
  { name: "Qwen2.5-32B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 中等规模，性价比高", params: "32B", context: "128K", price: "¥0.002/1K", popular: false },
  { name: "Qwen2.5-14B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 轻量级，适合低延迟场景", params: "14B", context: "128K", price: "¥0.001/1K", popular: false },
  { name: "Qwen2.5-7B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 最小规模，可本地部署", params: "7B", context: "128K", price: "¥0.0005/1K", popular: false },
  { name: "Qwen2.5-Coder-32B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 代码专用，代码生成和补全", params: "32B", context: "128K", price: "¥0.002/1K", popular: false },
  { name: "Qwen2.5-Math-72B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 数学专用，数学推理增强", params: "72B", context: "32K", price: "¥0.004/1K", popular: false },
  { name: "Qwen2-VL-72B-Instruct", provider: "阿里云百炼", type: "视觉模型", description: "Qwen2 视觉模型，图片和视频理解", params: "72B", context: "32K", price: "¥0.004/1K", popular: false },
  { name: "Qwen2-Audio-7B-Instruct", provider: "阿里云百炼", type: "语音模型", description: "Qwen2 语音模型，音频理解", params: "7B", context: "8K", price: "¥0.001/1K", popular: false },
  { name: "Qwen2.5-3B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 超轻量级，边缘设备可用", params: "3B", context: "32K", price: "¥0.0003/1K", popular: false },
  { name: "Qwen2.5-1.5B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 最小模型，嵌入式设备可用", params: "1.5B", context: "32K", price: "¥0.0002/1K", popular: false },
  { name: "Qwen2.5-0.5B-Instruct", provider: "阿里云百炼", type: "语言模型", description: "Qwen2.5 微型模型，极低资源消耗", params: "0.5B", context: "32K", price: "¥0.0001/1K", popular: false },
  { name: "qwq-32b-preview", provider: "阿里云百炼", type: "语言模型", description: "QwQ 推理模型预览版，深度推理和思考链", params: "32B", context: "128K", price: "¥0.012/1K", popular: true },
  { name: "Qwen3-235B-A22B", provider: "阿里云百炼", type: "语言模型", description: "Qwen3 MoE 架构，总参数235B激活22B，高效推理", params: "235B(A22B)", context: "128K", price: "¥0.006/1K", popular: true },
];

router.get("/", async (req: Request, res: Response) => {
  try {
    const { type, popular, region } = req.query;

    const conditions: string[] = ['status = ?'];
    const params: any[] = ['active'];

    if (type && type !== "全部") {
      conditions.push('type = ?');
      params.push(type);
    }
    if (popular === "true") {
      conditions.push('popular = ?');
      params.push(true);
    }
    if (region && region !== "全部") {
      conditions.push('region = ?');
      params.push(region);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [models] = await pool.execute(
      `SELECT * FROM model ${whereClause}
       ORDER BY recommended DESC, popular DESC, sort_order DESC, name ASC`,
      params
    );

    if ((models as any[]).length === 0 && !popular) {
      await syncAlibabaModels();
      const [synced] = await pool.execute(
        `SELECT * FROM model ${whereClause}
         ORDER BY recommended DESC, popular DESC, sort_order DESC, name ASC`,
        params
      );
      res.json(synced);
      return;
    }

    res.json(models);
  } catch (error) {
    console.error("Get models error:", error);
    res.status(500).json({ error: "获取模型列表失败" });
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
      res.status(404).json({ error: "模型不存在" });
      return;
    }

    res.json(model);
  } catch (error) {
    console.error("Get model error:", error);
    res.status(500).json({ error: "获取模型详情失败" });
  }
});

router.post(
  "/:id/buy",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const [modelRows] = await pool.execute(
        'SELECT * FROM model WHERE id = ?',
        [req.params.id]
      );
      const model = (modelRows as any[])[0];

      if (!model) {
        res.status(404).json({ error: "模型不存在" });
        return;
      }

      if (model.status !== "active") {
        res.status(400).json({ error: "模型暂未上架" });
        return;
      }

      const pricePerToken = model.sale_price ?? model.official_price ?? parseLegacyPrice(model.price) ?? 0;
      const tokens = req.body.tokens || 10000;
      const totalAmount = Math.ceil(pricePerToken * (tokens / 1000));

      const [buyerRows] = await pool.execute(
        'SELECT balance FROM user_users WHERE id = ?',
        [req.user!.userId]
      );
      const buyer = (buyerRows as any[])[0];

      if (!buyer || buyer.balance < totalAmount) {
        res.status(400).json({ error: "硅币余额不足" });
        return;
      }

      const orderId = generateId();
      await pool.execute(
        `INSERT INTO \`order\` (id, type, item_id, item_name, amount, buyer_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'paid', NOW(), NOW())`,
        [orderId, 'model', model.id, model.name, totalAmount, req.user!.userId]
      );

      await pool.execute(
        'UPDATE user_users SET balance = balance - ? WHERE id = ?',
        [totalAmount, req.user!.userId]
      );

      const [orderRows] = await pool.execute('SELECT * FROM `order` WHERE id = ?', [orderId]);

      res.json({ order: (orderRows as any[])[0], tokens, message: "购买成功" });
    } catch (error) {
      console.error("Buy model error:", error);
      res.status(500).json({ error: "购买失败" });
    }
  }
);

async function syncAlibabaModels() {
  for (const m of ALIBABA_MODELS) {
    const parsedPrice = parseLegacyPrice(m.price);
    const pricingUnit = inferPricingUnit(m.price);

    const [existing] = await pool.execute('SELECT id FROM model WHERE name = ?', [m.name]);

    if ((existing as any[]).length === 0) {
      await pool.execute(
        `INSERT INTO model (
          id, name, provider, type, description, params, context, price,
          popular, recommended, status, official_price, sale_price, pricing_unit,
          published_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [
          generateId(), m.name, m.provider, m.type, m.description, m.params, m.context, m.price,
          m.popular, m.popular, 'active', parsedPrice, parsedPrice, pricingUnit,
        ]
      );
    } else {
      await pool.execute(
        `UPDATE model SET
          provider = ?, type = ?, description = ?, params = ?, context = ?,
          price = ?, popular = ?, recommended = ?, status = ?,
          official_price = ?, sale_price = ?, pricing_unit = ?, published_at = NOW(), updated_at = NOW()
        WHERE name = ?`,
        [
          m.provider, m.type, m.description, m.params, m.context,
          m.price, m.popular, m.popular, 'active',
          parsedPrice, parsedPrice, pricingUnit, m.name,
        ]
      );
    }
  }
}

router.post("/sync", authMiddleware, requireAdmin, async (_req: Request, res: Response) => {
  try {
    await syncAlibabaModels();
    const [countRows] = await pool.execute('SELECT COUNT(*) as count FROM model');
    res.json({ success: true, message: `同步完成，共 ${(countRows as any[])[0]?.count} 个模型`, count: (countRows as any[])[0]?.count });
  } catch (error) {
    console.error("Sync models error:", error);
    res.status(500).json({ error: "同步失败" });
  }
});

export default router;

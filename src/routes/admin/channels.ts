/**
 * 管理端渠道（挂载 /api/admin/channels）
 *
 *   GET    /models              模型库分页/搜索（发车选模型用）
 *   GET    /channels            渠道列表
 *   POST   /channels            新增渠道（可选一次性写入多个 API Key）
 *   PUT    /channels/:id        更新渠道（api_keys 数组则全量替换 token 池）
 *   DELETE /channels/:id        删除渠道
 *   POST   /channels/:id/test   连通性测试（先 /v1/models，失败再对话探测）
 *   POST   /channels/:id/fetch-models  从上游拉取模型列表（不落库，仅回传 + 标记已关联）
 *
 * 渠道-模型关联 / 价格 / 忙闲时 见 channel-models.ts（同前缀挂载）。
 * 业务逻辑移植自 admin_backend/routes/channels.js（TS 化，adminAuth + gatewayPool）。
 */

import { Router, Request, Response } from "express";
import { gatewayPool } from "../../config/db";
import { adminAuth } from "../../middlewares/adminAuth";

const router = Router();
router.use(adminAuth);

/**
 * 把前端传来的各种 key 字段归一化成 [{name, api_key, weight, status}]
 *
 * 接受的形态：
 *   - api_keys: ["sk-xxx", "sk-yyy"]
 *   - api_keys: [{api_key:"sk-xxx", name:"k1", weight:2}, ...]
 *   - api_key:  "sk-xxx"                  （legacy 单 key 兼容）
 *
 * 空字符串/重复 key 会被去掉；保留录入顺序。
 */
function normalizeKeys(body: any): { name: string; api_key: string; weight: number; status: number }[] {
  const raw = body?.api_keys;
  const out: { name: string; api_key: string; weight: number; status: number }[] = [];
  const seen = new Set<string>();
  const push = (item: any, idx: number) => {
    if (!item) return;
    const apiKey = (typeof item === "string" ? item : item.api_key || "").trim();
    if (!apiKey || seen.has(apiKey)) return;
    seen.add(apiKey);
    out.push({
      name:
        typeof item === "object" && item?.name
          ? String(item.name).slice(0, 100)
          : `key-${idx + 1}`,
      api_key: apiKey,
      weight: Number.isFinite(Number(item?.weight)) && Number(item.weight) > 0 ? Number(item.weight) : 1,
      status: item?.status === 0 ? 0 : 1,
    });
  };

  if (Array.isArray(raw)) raw.forEach(push);
  if (body?.api_key && typeof body.api_key === "string") push(body.api_key, out.length);
  return out;
}

const CHANNEL_CODE_RE = /^[a-z][a-z0-9_]{1,31}$/;

function validateChannelCode(code: string | undefined | null): boolean {
  if (code === undefined || code === null || code === "") return true;
  return CHANNEL_CODE_RE.test(code);
}

// ============ 模型库（model_library） ============
router.get("/models", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "50"), 10)));
    const search = String(req.query.search || "").trim();
    const category = String(req.query.category || "").trim();
    const offset = (page - 1) * pageSize;

    // 仅列出模型库「启用且可见」的模型：模型库关闭(status=0 或 is_visible=0)的模型在渠道内查不到、不可关联
    const conds: string[] = ["status = 1", "is_visible = 1"];
    const params: any[] = [];
    if (search) { conds.push("(model_id LIKE ? OR display_name LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    if (category) { conds.push("category = ?"); params.push(category); }

    const where = `WHERE ${conds.join(" AND ")}`;
    const [cntRows] = await gatewayPool.execute(`SELECT COUNT(*) AS cnt FROM model_library ${where}`, params);
    const total = Number((cntRows as any[])[0].cnt || 0);

    const [rows] = await gatewayPool.execute(
      `SELECT model_id, display_name, category, is_hot, sort_order FROM model_library
       ${where} ORDER BY sort_order ASC, id ASC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    res.json({
      total,
      page,
      pageSize,
      models: (rows as any[]).map((m) => ({
        modelId: m.model_id,
        displayName: m.display_name,
        category: m.category,
        isHot: !!m.is_hot,
      })),
    });
  } catch (err) {
    console.error("Admin models error:", err);
    res.status(500).json({ error: "获取模型列表失败" });
  }
});

// ============ 渠道列表 ============
router.get("/channels", async (_req: Request, res: Response) => {
  try {
    const [rows] = await gatewayPool.execute(
      `SELECT c.id, c.name, c.type, c.base_url, c.status, c.priority, c.weight,
              c.token_lb_strategy, c.channel_code, c.api_key,
              (SELECT COUNT(*) FROM proxy_channel_models cm WHERE cm.channel_id = c.id AND cm.is_enabled = 1) AS model_count,
              (SELECT COUNT(*) FROM proxy_channel_tokens t WHERE t.channel_id = c.id) AS token_count
       FROM proxy_channels c
       ORDER BY c.id DESC`
    );
    const channels = rows as any[];

    // 拉取每个渠道下的全部 API Key（编辑回显用，代理渠道 key 池存在 proxy_channel_tokens）
    const keyMap = new Map<number, string[]>();
    if (channels.length > 0) {
      const holes = channels.map(() => "?").join(",");
      const [tokenRows] = await gatewayPool.execute(
        `SELECT channel_id, api_key_encrypted FROM proxy_channel_tokens
          WHERE channel_id IN (${holes}) ORDER BY id ASC`,
        channels.map((c) => c.id)
      );
      for (const tk of tokenRows as any[]) {
        const arr = keyMap.get(Number(tk.channel_id)) || [];
        arr.push(tk.api_key_encrypted);
        keyMap.set(Number(tk.channel_id), arr);
      }
    }

    res.json({
      channels: channels.map((c) => ({
        ...c,
        // 编辑回显用：完整 key 池；没有 token 行时兜底用 legacy 单 key 字段
        api_keys: keyMap.get(Number(c.id)) || (c.api_key ? [c.api_key] : []),
      })),
    });
  } catch (err) {
    console.error("Admin channels error:", err);
    res.status(500).json({ error: "获取渠道列表失败" });
  }
});

// ============ Provider 能力清单 ============
router.get("/capabilities", async (_req: Request, res: Response) => {
  try {
    const [rows] = await gatewayPool.execute(
      `SELECT id, provider_alias, domain, name, class_name
         FROM provider_capabilities
        ORDER BY domain ASC, id ASC`
    );
    res.json({ capabilities: rows as any[] });
  } catch (err) {
    console.error("Admin provider capabilities error:", err);
    res.status(500).json({ error: "获取能力清单失败" });
  }
});

// ============ 新增渠道 ============
router.post("/channels", async (req: Request, res: Response) => {
  const { name, type, base_url, priority, weight, token_lb_strategy, channel_code } = req.body || {};
  const keys = normalizeKeys(req.body);
  if (!name || !base_url) {
    res.status(400).json({ error: "名称、Base URL 为必填项" });
    return;
  }
  if (!validateChannelCode(channel_code)) {
    res.status(400).json({ error: "渠道代码格式不正确，只能包含小写字母、数字和下划线，且必须以字母开头" });
    return;
  }

  try {
    const conn = await gatewayPool.getConnection();
    let channelId: number;
    try {
      await conn.beginTransaction();
      // 第一个 key 同时写进 proxy_channels.api_key 做 legacy 兜底；没传 keys 就用空串占位
      const legacyApiKey = keys[0]?.api_key || "";
      const [r] = await conn.execute(
        `INSERT INTO proxy_channels
           (name, type, base_url, api_key, priority, weight, token_lb_strategy, channel_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name, type || "openai", base_url, legacyApiKey,
          priority || 0, weight || 1,
          token_lb_strategy || "round_robin",
          channel_code || null,
        ]
      );
      channelId = (r as any).insertId;

      for (const k of keys) {
        await conn.execute(
          `INSERT INTO proxy_channel_tokens
             (channel_id, name, api_key_encrypted, weight, status)
           VALUES (?, ?, ?, ?, ?)`,
          [channelId, k.name, k.api_key, k.weight, k.status]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({
      id: channelId,
      token_count: keys.length,
      message: keys.length === 0 ? "渠道创建成功，请到渠道编辑中添加 API Key" : "渠道创建成功",
    });
  } catch (err: any) {
    console.error("[channels] create error:", err);
    if (err?.code === "ER_DUP_ENTRY" && String(err?.message || "").includes("channel_code")) {
      res.status(409).json({ error: "渠道代码已存在，请使用其他代码" });
      return;
    }
    res.status(500).json({ error: "创建渠道失败" });
  }
});

// ============ 更新渠道 ============
router.put("/channels/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const body = req.body || {};
  const {
    name, type, base_url, api_key, status, priority, weight,
    token_lb_strategy, channel_code,
  } = body;
  const replacingKeys = Array.isArray(body.api_keys);
  const newKeys = replacingKeys ? normalizeKeys(body) : null;

  if (replacingKeys && newKeys!.length === 0) {
    res.status(400).json({ error: "至少需要一个 API Key" });
    return;
  }
  if (!validateChannelCode(channel_code)) {
    res.status(400).json({ error: "渠道代码格式不正确，只能包含小写字母、数字和下划线，且必须以字母开头" });
    return;
  }

  try {
    const [rows] = await gatewayPool.execute("SELECT * FROM proxy_channels WHERE id = ? LIMIT 1", [id]);
    const channel = (rows as any[])[0];
    if (!channel) {
      res.status(404).json({ error: "渠道不存在" });
      return;
    }

    const after = {
      name: name !== undefined ? name : channel.name,
      type: type !== undefined ? type : channel.type,
      base_url: base_url !== undefined ? base_url : channel.base_url,
      api_key: replacingKeys ? newKeys![0].api_key : (api_key !== undefined ? api_key : channel.api_key),
      status: status !== undefined ? status : channel.status,
      priority: priority !== undefined ? priority : channel.priority,
      weight: weight !== undefined ? weight : channel.weight,
      token_lb_strategy: token_lb_strategy !== undefined ? token_lb_strategy : channel.token_lb_strategy,
      channel_code: channel_code !== undefined ? channel_code : channel.channel_code,
    };

    const conn = await gatewayPool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE proxy_channels
            SET name=?, type=?, base_url=?, api_key=?, status=?, priority=?, weight=?,
                token_lb_strategy=?, channel_code=?, updated_at=CURRENT_TIMESTAMP
          WHERE id=?`,
        [
          after.name, after.type, after.base_url, after.api_key,
          after.status, after.priority, after.weight, after.token_lb_strategy,
          after.channel_code, id,
        ]
      );
      if (replacingKeys) {
        await conn.execute("DELETE FROM proxy_channel_tokens WHERE channel_id = ?", [id]);
        for (const k of newKeys!) {
          await conn.execute(
            `INSERT INTO proxy_channel_tokens
               (channel_id, name, api_key_encrypted, weight, status)
             VALUES (?, ?, ?, ?, ?)`,
            [id, k.name, k.api_key, k.weight, k.status]
          );
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({
      message: "渠道更新成功",
      ...(replacingKeys ? { token_count: newKeys!.length } : {}),
    });
  } catch (err: any) {
    console.error("[channels] update error:", err);
    if (err?.code === "ER_DUP_ENTRY" && String(err?.message || "").includes("channel_code")) {
      res.status(409).json({ error: "渠道代码已存在，请使用其他代码" });
      return;
    }
    res.status(500).json({ error: "更新渠道失败" });
  }
});

// ============ 删除渠道 ============
router.delete("/channels/:id", async (req: Request, res: Response) => {
  const conn = await gatewayPool.getConnection();
  try {
    const [rows] = await conn.execute("SELECT id FROM proxy_channels WHERE id = ? LIMIT 1", [req.params.id]);
    if ((rows as any[]).length === 0) {
      conn.release();
      res.status(404).json({ error: "渠道不存在" });
      return;
    }
    const id = req.params.id;
    await conn.beginTransaction();

    // 先取该渠道下 model_prices 的 id，级联清理价格档位/时段（proxy_logs 保留作消费历史）
    // 注意：mysql2 execute 不展开 IN (?) 数组，需手动拼占位符
    const [priceRows] = await conn.execute(
      "SELECT id FROM model_prices WHERE channel_id = ?",
      [id]
    );
    const priceIds = (priceRows as any[]).map((r) => r.id);
    if (priceIds.length > 0) {
      const priceHoles = priceIds.map(() => "?").join(",");
      const [tierRows] = await conn.execute(
        `SELECT id FROM model_price_tiers WHERE price_id IN (${priceHoles})`,
        priceIds
      );
      const tierIds = (tierRows as any[]).map((r) => r.id);
      if (tierIds.length > 0) {
        const tierHoles = tierIds.map(() => "?").join(",");
        await conn.execute(
          `DELETE FROM price_tier_time_ranges WHERE tier_id IN (${tierHoles})`,
          tierIds
        );
      }
      await conn.execute(
        `DELETE FROM model_price_tiers WHERE price_id IN (${priceHoles})`,
        priceIds
      );
      await conn.execute("DELETE FROM model_prices WHERE channel_id = ?", [id]);
    }

    await conn.execute("DELETE FROM proxy_channel_models WHERE channel_id = ?", [id]);
    await conn.execute("DELETE FROM proxy_channel_tokens WHERE channel_id = ?", [id]);
    await conn.execute("DELETE FROM proxy_channels WHERE id = ?", [id]);

    await conn.commit();
    res.json({ message: "渠道删除成功" });
  } catch (err) {
    try { await conn.rollback(); } catch (e) { console.error("[channels] rollback failed:", e); }
    console.error("[channels] delete error:", err);
    res.status(500).json({ error: "删除渠道失败" });
  } finally {
    conn.release();
  }
});

// ============ 连通性测试 ============
router.post("/channels/:id/test", async (req: Request, res: Response) => {
  try {
    const [rows] = await gatewayPool.execute("SELECT * FROM proxy_channels WHERE id = ? LIMIT 1", [req.params.id]);
    const channel = (rows as any[])[0];
    if (!channel) {
      res.status(404).json({ error: "渠道不存在" });
      return;
    }

    const startTime = Date.now();
    try {
      const baseUrl = String(channel.base_url || "").replace(/\/+$/, "");
      const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
      const chatUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

      let response: globalThis.Response | undefined;
      // 1. 优先尝试标准的 /models 接口（最轻量）
      try {
        response = await fetch(modelsUrl, {
          headers: { Authorization: `Bearer ${channel.api_key}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // 忽略错误，继续尝试下一步
      }

      // 2. 如果 /models 不可用（404/405/超时），则尝试进行真实的对话探测
      if (!response || response.status === 404 || response.status === 405) {
        const [cmRows] = await gatewayPool.execute(
          `SELECT model_id FROM proxy_channel_models
            WHERE channel_id = ? AND is_enabled = 1 AND model_id <> '*'
            ORDER BY priority DESC LIMIT 1`,
          [req.params.id]
        );
        const testModel = (cmRows as any[])[0]?.model_id || "gpt-3.5-turbo";

        try {
          response = await fetch(chatUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${channel.api_key}`,
              "Content-Type": "application/json",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Accept: "application/json",
            },
            body: JSON.stringify({
              model: testModel,
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1,
              stream: false,
            }),
            signal: AbortSignal.timeout(30000),
          });
        } catch (err: any) {
          res.json({ success: false, latency: Date.now() - startTime, message: `对话端点响应超时或无法访问: ${err?.message}` });
          return;
        }
      }

      const latency = Date.now() - startTime;

      if (response!.ok) {
        res.json({ success: true, latency, message: "连接正常" });
      } else if (response!.status === 401 || response!.status === 403) {
        res.json({ success: false, latency, message: "认证失败 (401/403)，请检查 API Key" });
      } else {
        const errText = await response!.text().catch(() => "");
        let errMsg = `HTTP ${response!.status}`;
        try {
          if (errText) {
            const errJson = JSON.parse(errText);
            errMsg = errJson.error?.message || errJson.message || errMsg;
            if (errJson.error?.code) errMsg += ` (${errJson.error.code})`;
          }
        } catch {
          // 忽略解析失败，保留 HTTP 状态信息
        }
        res.json({ success: false, latency, message: errMsg });
      }
    } catch (err: any) {
      res.json({ success: false, latency: Date.now() - startTime, message: err?.message || "连接失败" });
    }
  } catch (err) {
    console.error("[channels] test error:", err);
    res.status(500).json({ error: "测试渠道失败" });
  }
});

// ============ 从上游拉取模型列表 ============
router.post("/channels/:id/fetch-models", async (req: Request, res: Response) => {
  try {
    const [rows] = await gatewayPool.execute("SELECT * FROM proxy_channels WHERE id = ? LIMIT 1", [req.params.id]);
    const channel = (rows as any[])[0];
    if (!channel) {
      res.status(404).json({ error: "渠道不存在" });
      return;
    }

    const baseUrl = String(channel.base_url || "").replace(/\/+$/, "");
    const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;

    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${channel.api_key}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      let errMsg = `HTTP ${response.status}`;
      try {
        if (errText) {
          const errJson = JSON.parse(errText);
          errMsg = errJson.error?.message || errJson.message || errMsg;
        }
      } catch {
        // 忽略
      }
      res.status(502).json({ error: `拉取模型列表失败: ${errMsg}` });
      return;
    }

    const data = (await response.json()) as any;
    const ids: string[] = Array.isArray(data?.data)
      ? data.data.map((m: any) => (typeof m === "string" ? m : m?.id)).filter(Boolean)
      : [];

    // 标记哪些模型已关联该渠道、哪些已在模型库
    const [ownedRows] = await gatewayPool.execute(
      "SELECT model_id FROM proxy_channel_models WHERE channel_id = ?",
      [req.params.id]
    );
    const ownedSet = new Set((ownedRows as any[]).map((r) => r.model_id));
    const [libRows] = await gatewayPool.execute("SELECT model_id FROM model_library");
    const libSet = new Set((libRows as any[]).map((r) => r.model_id));

    res.json({
      channelId: channel.id,
      models: ids.map((id: string) => ({
        id,
        owned: ownedSet.has(id),
        inLibrary: libSet.has(id),
      })),
    });
  } catch (err: any) {
    console.error("[channels] fetch-models error:", err);
    res.status(502).json({ error: `拉取模型列表失败: ${err?.message || "网络错误"}` });
  }
});

export default router;

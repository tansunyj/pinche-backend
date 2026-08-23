/**
 * 火山引擎人像库代理路由
 *
 * 提供人像素材的 CRUD 和同步功能
 * 所有接口需要认证 (JWT 或 API Key)
 */

import { Router } from "express";
import pool from "../db/mysql";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { authMiddleware } from "../middleware/auth";
import multer from "multer";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const VOLCTOKENS_BASE_URL = process.env.VOLCTOKENS_BASE_URL || "https://volctokens.api.mengfactory.cn";
const VOLCTOKENS_API_KEY = process.env.VOLCTOKENS_API_KEY;

/** volc_assets 表结构 */
interface VolcAssetRow extends RowDataPacket {
  id: number;
  user_id: number;
  asset_id: string;
  asset_uri: string;
  asset_type: string;
  name: string | null;
  status: string;
  preview_url: string | null;
  delete_after: number | null;
  duration_seconds: number | null;
  created_at: Date;
  updated_at: Date;
}

/** VolcTokens 素材结构 */
interface VolcTokensAsset {
  id: string;
  uri: string;
  type: "Image" | "Video";
  name?: string;
  status: "processing" | "active" | "failed" | "deleted";
  preview_url?: string;
  delete_after?: number;
  duration_seconds?: number;
}

/**
 * GET /api/media/volc/assets
 * 列表面像素材（从缓存表查询）
 */
router.get("/volc/assets", authMiddleware, async (req, res) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    return res.status(401).json({ error: "未登录" });
  }

  try {
    const assetType = req.query.asset_type as string | undefined;
    const status = req.query.status as string | undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(req.query.page_size) || 20));
    const refresh = req.query.refresh === "true";

    // 如果需要刷新，先同步远端素材
    if (refresh) {
      await syncAssetsFromRemote(userId);
    }

    // 构建查询条件
    const conditions: string[] = ["user_id = ?"];
    const params: any[] = [userId];

    if (assetType) {
      conditions.push("asset_type = ?");
      params.push(assetType);
    }
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    } else {
      // 默认不显示已删除的
      conditions.push("status != 'deleted'");
    }

    // 查询总数
    const [countRows] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as total FROM volc_assets WHERE ${conditions.join(" AND ")}`,
      params
    );
    const total = countRows[0]?.total || 0;

    // 查询列表
    const [rows] = await pool.execute<VolcAssetRow[]>(
      `SELECT * FROM volc_assets
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    res.json({
      success: true,
      data: {
        list: rows.map(row => ({
          id: row.id,
          asset_id: row.asset_id,
          asset_uri: row.asset_uri,
          asset_type: row.asset_type,
          name: row.name,
          status: row.status,
          preview_url: row.preview_url,
          delete_after: row.delete_after,
          duration_seconds: row.duration_seconds,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.ceil(total / pageSize),
        },
      },
    });
  } catch (error) {
    console.error("[VolcAssets] 列表查询失败:", error);
    res.status(500).json({ error: "查询失败", message: (error as Error).message });
  }
});

/**
 * POST /api/media/volc/assets
 * 上传人像素材（转发到 VolcTokens）
 */
router.post("/volc/assets", authMiddleware, upload.single("file"), async (req, res) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    return res.status(401).json({ error: "未登录" });
  }

  if (!VOLCTOKENS_API_KEY) {
    return res.status(503).json({ error: "VolcTokens 未配置" });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "请选择文件" });
  }

  const assetType = (req.body.asset_type as string) || "Image";
  const name = (req.body.name as string) || file.originalname;

  try {
    // 构建 FormData
    const formData = new FormData();
    formData.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    formData.append("asset_type", assetType);
    if (name) formData.append("name", name);

    // 转发到 VolcTokens
    const response = await fetch(`${VOLCTOKENS_BASE_URL}/api/volc/assets`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${VOLCTOKENS_API_KEY}`,
      },
      body: formData,
    });

    const data = await response.json() as { error?: string; id?: string; asset_id?: string; uri?: string; status?: string; preview_url?: string; delete_after?: number; duration_seconds?: number };

    if (!response.ok) {
      console.error("[VolcAssets] 上传失败:", data);
      return res.status(response.status).json({
        error: "上传失败",
        message: data.error || `VolcTokens 错误 (${response.status})`,
      });
    }

    // 保存到缓存表
    const assetId = data.id || data.asset_id;
    const assetUri = data.uri || `asset://${assetId}`;

    await pool.execute(
      `INSERT INTO volc_assets
       (user_id, asset_id, asset_uri, asset_type, name, status, preview_url, delete_after, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       status = VALUES(status),
       preview_url = VALUES(preview_url),
       updated_at = NOW()`,
      [
        userId,
        assetId,
        assetUri,
        assetType,
        name,
        data.status || "processing",
        data.preview_url || null,
        data.delete_after || null,
        data.duration_seconds || null,
      ]
    );

    res.json({
      success: true,
      data: {
        id: assetId,
        uri: assetUri,
        type: assetType,
        name,
        status: data.status || "processing",
        preview_url: data.preview_url,
      },
    });
  } catch (error) {
    console.error("[VolcAssets] 上传异常:", error);
    res.status(500).json({ error: "上传失败", message: (error as Error).message });
  }
});

/**
 * GET /api/media/volc/assets/:id
 * 查询单个人像素材
 */
router.get("/volc/assets/:id", authMiddleware, async (req, res) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    return res.status(401).json({ error: "未登录" });
  }

  const assetId = req.params.id;
  const refresh = req.query.refresh === "true";

  try {
    // 如果需要刷新，先查询远端状态
    if (refresh && VOLCTOKENS_API_KEY) {
      try {
        const response = await fetch(`${VOLCTOKENS_BASE_URL}/v1/volc/assets/${assetId}`, {
          headers: { "Authorization": `Bearer ${VOLCTOKENS_API_KEY}` },
        });

        if (response.ok) {
          const data = await response.json() as { status?: string; preview_url?: string; delete_after?: number };
          // 更新缓存
          await pool.execute(
            `UPDATE volc_assets SET
             status = ?,
             preview_url = ?,
             delete_after = ?,
             updated_at = NOW()
             WHERE user_id = ? AND asset_id = ?`,
            [
              data.status,
              data.preview_url || null,
              data.delete_after || null,
              userId,
              assetId,
            ]
          );
        }
      } catch (e) {
        console.warn("[VolcAssets] 刷新远端状态失败:", e);
      }
    }

    // 查询缓存表
    const [rows] = await pool.execute<VolcAssetRow[]>(
      `SELECT * FROM volc_assets WHERE user_id = ? AND asset_id = ? LIMIT 1`,
      [userId, assetId]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "素材不存在" });
    }

    res.json({
      success: true,
      data: {
        id: rows[0].id,
        asset_id: rows[0].asset_id,
        asset_uri: rows[0].asset_uri,
        asset_type: rows[0].asset_type,
        name: rows[0].name,
        status: rows[0].status,
        preview_url: rows[0].preview_url,
        delete_after: rows[0].delete_after,
        duration_seconds: rows[0].duration_seconds,
        created_at: rows[0].created_at,
        updated_at: rows[0].updated_at,
      },
    });
  } catch (error) {
    console.error("[VolcAssets] 查询失败:", error);
    res.status(500).json({ error: "查询失败", message: (error as Error).message });
  }
});

/**
 * DELETE /api/media/volc/assets/:id
 * 删除人像素材
 */
router.delete("/volc/assets/:id", authMiddleware, async (req, res) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    return res.status(401).json({ error: "未登录" });
  }

  if (!VOLCTOKENS_API_KEY) {
    return res.status(503).json({ error: "VolcTokens 未配置" });
  }

  const assetId = req.params.id;

  try {
    // 先删除远端
    const response = await fetch(`${VOLCTOKENS_BASE_URL}/v1/volc/assets/${assetId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${VOLCTOKENS_API_KEY}` },
    });

    if (!response.ok && response.status !== 404) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      return res.status(response.status).json({
        error: "删除失败",
        message: data.error || `VolcTokens 错误 (${response.status})`,
      });
    }

    // 软删缓存
    await pool.execute(
      `UPDATE volc_assets SET status = 'deleted', updated_at = NOW()
       WHERE user_id = ? AND asset_id = ?`,
      [userId, assetId]
    );

    res.json({ success: true, message: "删除成功" });
  } catch (error) {
    console.error("[VolcAssets] 删除失败:", error);
    res.status(500).json({ error: "删除失败", message: (error as Error).message });
  }
});

/**
 * POST /api/media/volc/assets/sync
 * 同步远端素材到缓存表
 */
router.post("/volc/assets/sync", authMiddleware, async (req, res) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    return res.status(401).json({ error: "未登录" });
  }

  if (!VOLCTOKENS_API_KEY) {
    return res.status(503).json({ error: "VolcTokens 未配置" });
  }

  try {
    const result = await syncAssetsFromRemote(userId);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[VolcAssets] 同步失败:", error);
    res.status(500).json({ error: "同步失败", message: (error as Error).message });
  }
});

/**
 * 从 VolcTokens 同步素材到本地缓存
 */
async function syncAssetsFromRemote(userId: number): Promise<{
  added: number;
  updated: number;
  removed: number;
}> {
  if (!VOLCTOKENS_API_KEY) {
    throw new Error("VOLCTOKENS_API_KEY 未配置");
  }

  // 拉取远端列表
  const response = await fetch(`${VOLCTOKENS_BASE_URL}/v1/volc/assets`, {
    headers: { "Authorization": `Bearer ${VOLCTOKENS_API_KEY}` },
  });

  if (!response.ok) {
    throw new Error(`VolcTokens 查询失败: ${response.status}`);
  }

  const data = await response.json() as { data?: VolcTokensAsset[] } | VolcTokensAsset[];
  const remoteAssets: VolcTokensAsset[] = Array.isArray(data) ? data : data.data || [];

  // 获取本地列表
  const [localRows] = await pool.execute<VolcAssetRow[]>(
    `SELECT asset_id, status FROM volc_assets WHERE user_id = ?`,
    [userId]
  );
  const localAssetIds = new Set(localRows.map(r => r.asset_id));

  let added = 0;
  let updated = 0;

  // 同步远端素材到本地
  for (const asset of remoteAssets) {
    const isNew = !localAssetIds.has(asset.id);

    await pool.execute(
      `INSERT INTO volc_assets
       (user_id, asset_id, asset_uri, asset_type, name, status, preview_url, delete_after, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       asset_type = VALUES(asset_type),
       name = VALUES(name),
       status = VALUES(status),
       preview_url = VALUES(preview_url),
       delete_after = VALUES(delete_after),
       duration_seconds = VALUES(duration_seconds),
       updated_at = NOW()`,
      [
        userId,
        asset.id,
        asset.uri || `asset://${asset.id}`,
        asset.type,
        asset.name || null,
        asset.status,
        asset.preview_url || null,
        asset.delete_after || null,
        asset.duration_seconds || null,
      ]
    );

    if (isNew) added++;
    else updated++;
  }

  // 远端已删除的素材，本地标记为 deleted
  const remoteAssetIds = new Set(remoteAssets.map(a => a.id));
  let removed = 0;
  for (const localId of localAssetIds) {
    if (!remoteAssetIds.has(localId)) {
      await pool.execute(
        `UPDATE volc_assets SET status = 'deleted', updated_at = NOW()
         WHERE user_id = ? AND asset_id = ?`,
        [userId, localId]
      );
      removed++;
    }
  }

  console.log(`[VolcAssets] 同步完成: 新增 ${added}, 更新 ${updated}, 移除 ${removed}`);
  return { added, updated, removed };
}

/**
 * POST /api/media/volc/upload
 * 上传参考音频/视频文件（用于 reference_audio / reference_video）
 */
router.post("/volc/upload", authMiddleware, upload.single("file"), async (req, res) => {
  const userId = (req as any).user?.userId;
  if (!userId) {
    return res.status(401).json({ error: "未登录" });
  }

  if (!VOLCTOKENS_API_KEY) {
    return res.status(503).json({ error: "VolcTokens 未配置" });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "请选择文件" });
  }

  // 限制文件类型：音频或视频
  const allowedMimes = [
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/aac",
    "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
  ];
  if (!allowedMimes.includes(file.mimetype)) {
    return res.status(400).json({ error: "不支持的文件类型，请上传音频或视频文件" });
  }

  try {
    // 构建 FormData
    const formData = new FormData();
    formData.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);

    // 转发到 VolcTokens
    const response = await fetch(`${VOLCTOKENS_BASE_URL}/api/upload`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${VOLCTOKENS_API_KEY}`,
      },
      body: formData,
    });

    const data = await response.json() as { error?: string; url?: string; duration?: number };

    if (!response.ok) {
      console.error("[VolcUpload] 上传失败:", data);
      return res.status(response.status).json({
        error: "上传失败",
        message: data.error || `VolcTokens 错误 (${response.status})`,
      });
    }

    res.json({
      success: true,
      data: {
        url: data.url,
        mime: file.mimetype,
        size: file.size,
        duration: data.duration || null,
      },
    });
  } catch (error) {
    console.error("[VolcUpload] 上传异常:", error);
    res.status(500).json({ error: "上传失败", message: (error as Error).message });
  }
});

export default router;

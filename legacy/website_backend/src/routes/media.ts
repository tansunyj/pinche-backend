/**
 * 多媒体创作工作室路由
 *
 * 全部需登录（authMiddleware）。
 * 路由总览：
 *   POST   /jobs                    提交任务
 *   GET    /jobs                    我的任务列表
 *   GET    /jobs/:id                查任务（前端轮询）
 *   POST   /jobs/:id/cancel         用户取消
 *
 *   GET    /assets                  我的资产列表（筛选/分页）
 *   GET    /assets/:id              单个资产
 *   POST   /upload                  上传图片（用作 I2I/I2V 输入）
 *   PATCH  /assets/:id              编辑名字/标签/收藏
 *   POST   /assets/batch-delete     批量软删
 *
 *   GET    /prompts                 提示词收藏夹
 *   POST   /prompts                 收藏一条提示词
 *   PATCH  /prompts/:id             编辑收藏
 *   DELETE /prompts/:id             取消收藏
 *   POST   /prompts/:id/use         一键复用（累加 use_count）
 *
 *   GET    /providers               可用 Provider 列表（前端模型卡片置灰用）
 */

import { Router, type Request, type Response } from "express";
// 依赖 multer 需安装：npm i multer @types/multer
// eslint-disable-next-line @typescript-eslint/no-var-requires
const multer: any = require("multer");
import { authMiddleware, apiKeyAuthMiddleware } from "../middleware/auth";
import MediaJobService from "../services/MediaJobService";
import MediaAssetService from "../services/MediaAssetService";
import PromptLibraryService from "../services/PromptLibraryService";
import OssService from "../services/storage/OssService";
import { describeProviders } from "../services/media";
import type { MediaKind } from "../services/media/MediaProvider";

const router = Router();

const UPLOAD_MAX_MB = Number(process.env.MEDIA_UPLOAD_MAX_MB) || 20;
const UPLOAD_ACCEPT = (process.env.MEDIA_UPLOAD_ACCEPT || "image/png,image/jpeg,image/webp")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 参考素材上传支持的 MIME 类型（图片 + 视频 + 音频）
const REFERENCE_UPLOAD_ACCEPT = [
  "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif",
  "video/mp4", "video/quicktime",
  "audio/wav", "audio/mp3", "audio/mpeg", "audio/x-wav",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    if (!UPLOAD_ACCEPT.includes(file.mimetype)) {
      cb(new Error(`不支持的文件类型：${file.mimetype}，允许：${UPLOAD_ACCEPT.join(", ")}`));
      return;
    }
    cb(null, true);
  },
});

// 参考素材上传（图片+视频+音频），视频最大 200MB，音频最大 15MB
const uploadReference = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB 上限
  fileFilter: (_req: any, file: any, cb: any) => {
    if (!REFERENCE_UPLOAD_ACCEPT.includes(file.mimetype)) {
      cb(new Error(`不支持的文件类型：${file.mimetype}，允许：${REFERENCE_UPLOAD_ACCEPT.join(", ")}`));
      return;
    }
    cb(null, true);
  },
});

// 导入 TokenService 用于组合认证
import TokenService from "../services/TokenService";

// 组合认证中间件：优先尝试 API Key（sk-xxx 格式），否则尝试 JWT
async function combinedAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  
  // 没有授权头，直接尝试 JWT (支持 Cookie)
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return authMiddleware(req, res, next);
  }
  
  const token = authHeader.slice(7);
  
  // 判断是 API Key 格式 (sk-xxx) 还是 JWT
  if (token.startsWith("sk-")) {
    try {
      const proxyToken = await TokenService.findByKey(token);
      if (proxyToken && proxyToken.status === 1) {
        // 检查生效时间和过期时间
        if (proxyToken.start_at && new Date(proxyToken.start_at) > new Date()) {
          return res.status(403).json({ error: "API Key 尚未生效" });
        }
        if (proxyToken.expired_at && new Date(proxyToken.expired_at) < new Date()) {
          return res.status(401).json({ error: "API Key 已过期" });
        }
        if (proxyToken.quota > 0 && proxyToken.used_quota >= proxyToken.quota) {
          return res.status(402).json({ error: "API Key 额度已用尽" });
        }
        req.apiToken = proxyToken;
        return next();
      }
    } catch {
      // API Key 查找失败，继续尝试 JWT
    }
  }
  
  // 尝试 JWT 认证
  return authMiddleware(req, res, next);
}

// 所有路由使用组合鉴权（支持 API Key 或 JWT）
router.use(combinedAuthMiddleware);

// ─────────────── 工具 ───────────────

function getUserId(req: Request): number {
  // 优先从 JWT 获取（个人中心页面调用）
  if (req.user?.userId) return req.user.userId;
  // 其次从 API Token 获取（API 调用）
  const uid = req.apiToken?.user_id;
  if (typeof uid !== "number") throw new Error("未授权");
  return uid;
}

const VALID_KINDS: MediaKind[] = ["t2i", "i2i", "t2v", "i2v", "flf2v"];

function parseInt0(v: unknown, def = 0): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

// =============== Jobs ===============

router.post("/jobs", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const {
      kind,
      modelId,
      prompt,
      negativePrompt,
      inputAssetId,
      inputAssetIdEnd,
      params,
      idempotencyKey,
    } = req.body ?? {};

    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `无效 kind：${kind}` });
    }

    const job = await MediaJobService.submitJob({
      userId,
      kind,
      modelId,
      prompt: String(prompt ?? ""),
      negativePrompt: negativePrompt ? String(negativePrompt) : null,
      inputAssetId: inputAssetId ? Number(inputAssetId) : null,
      inputAssetIdEnd: inputAssetIdEnd ? Number(inputAssetIdEnd) : null,
      params: params && typeof params === "object" ? params : {},
      idempotencyKey: idempotencyKey ? String(idempotencyKey).slice(0, 64) : undefined,
    });
    res.json({ success: true, data: job });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "提交任务失败" });
  }
});

router.get("/jobs", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { kind, status, limit, offset } = req.query as Record<string, string>;
    const data = await MediaJobService.listUserJobs({
      userId,
      kind: kind && VALID_KINDS.includes(kind as MediaKind) ? (kind as MediaKind) : undefined,
      status: status as any,
      limit: parseInt0(limit, 30),
      offset: parseInt0(offset, 0),
    });
    res.json({ success: true, ...data });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "查询失败" });
  }
});

router.get("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const job = await MediaJobService.findById(Number(req.params.id), userId);
    if (!job) return res.status(404).json({ success: false, error: "任务不存在" });

    // 附带产物资产 DTO（带签名 URL），前端就不用再单独请求
    let outputAsset = null;
    if (job.output_asset_id) {
      outputAsset = await MediaAssetService.findById(job.output_asset_id, userId);
    }
    res.json({ success: true, data: { ...job, output_asset: outputAsset } });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "查询失败" });
  }
});

router.post("/jobs/:id/cancel", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    await MediaJobService.cancelByUser(Number(req.params.id), userId);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "取消失败" });
  }
});

// =============== Assets ===============

router.get("/assets", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { type, favorite, limit, offset } = req.query as Record<string, string>;
    const data = await MediaAssetService.listUserAssets({
      userId,
      type: type === "image" || type === "video" ? type : undefined,
      favoriteOnly: favorite === "true" || favorite === "1",
      limit: parseInt0(limit, 30),
      offset: parseInt0(offset, 0),
    });
    res.json({ success: true, ...data });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "查询失败" });
  }
});

router.get("/assets/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const a = await MediaAssetService.findById(Number(req.params.id), userId);
    if (!a) return res.status(404).json({ success: false, error: "资产不存在" });
    res.json({ success: true, data: a });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "查询失败" });
  }
});

/**
 * 上传临时参考素材（图片/视频/音频，用于视频生成参考输入）
 * 只上传 OSS，不入库 media_assets
 */
router.post("/upload-temp", uploadReference.single("file"), async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const file = (req as any).file as { buffer: Buffer; mimetype: string; size: number } | undefined;
    if (!file) return res.status(400).json({ success: false, error: "缺少文件" });

    // 只上传 OSS，不入库
    const ossKey = OssService.buildKey({
      userId,
      kind: "upload",
      mime: file.mimetype,
    });
    const put = await OssService.putObject({
      ossKey,
      body: file.buffer,
      mime: file.mimetype,
    });

    // 生成签名 URL（1小时有效）
    const signedUrl = await OssService.getSignedUrl(put.ossKey, 3600);

    res.json({
      success: true,
      data: {
        ossKey: put.ossKey,
        url: signedUrl,
        mime: put.mime,
        size: put.size,
      },
    });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "上传失败" });
  }
});

/**
 * 上传图片到 OSS（用于视频生成 I2V/R2V）
 * 专门给活动 Token 用户使用
 * POST /api/media/upload-for-video
 */
router.post("/upload-for-video", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const file = (req as any).file as { buffer: Buffer; mimetype: string; size: number } | undefined;
    if (!file) return res.status(400).json({ success: false, error: "缺少文件" });

    // 可选：检查用户是否有活动 Token（如果启用了活动限制）
    // const hasActivityToken = await checkUserActivityToken(userId);
    // if (!hasActivityToken) {
    //   return res.status(403).json({ success: false, error: "请先领取活动 Token" });
    // }

    // 上传到 OSS，使用特定路径标识用途
    const ossKey = OssService.buildKey({
      userId,
      kind: "video-input",  // 用于视频生成的输入图片
      mime: file.mimetype,
    });
    const put = await OssService.putObject({
      ossKey,
      body: file.buffer,
      mime: file.mimetype,
    });

    // 生成签名 URL（1小时有效）
    const signedUrl = await OssService.getSignedUrl(put.ossKey, 3600);

    console.log(`[UploadForVideo] user=${userId}, key=${ossKey}, size=${put.size}`);

    res.json({
      success: true,
      data: {
        ossKey: put.ossKey,
        url: signedUrl,
        mime: put.mime,
        size: put.size,
        expiresIn: 3600,
      },
    });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "上传失败" });
  }
});

/**
 * 批量上传图片（用于多图参考生视频 R2V）
 * POST /api/media/upload-batch-for-video
 */
router.post("/upload-batch-for-video", upload.array("files", 5), async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const files = (req as any).files as { buffer: Buffer; mimetype: string; size: number }[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: "缺少文件" });
    }
    if (files.length > 5) {
      return res.status(400).json({ success: false, error: "最多上传5张图片" });
    }

    // 并行上传所有文件
    const results = await Promise.all(
      files.map(async (file, index) => {
        const ossKey = OssService.buildKey({
          userId,
          kind: "video-input",
          mime: file.mimetype,
        });
        const put = await OssService.putObject({
          ossKey,
          body: file.buffer,
          mime: file.mimetype,
        });
        const signedUrl = await OssService.getSignedUrl(put.ossKey, 3600);
        return {
          index,
          ossKey: put.ossKey,
          url: signedUrl,
          mime: put.mime,
          size: put.size,
        };
      })
    );

    console.log(`[UploadBatchForVideo] user=${userId}, count=${results.length}`);

    res.json({
      success: true,
      data: {
        files: results,
        count: results.length,
        expiresIn: 3600,
      },
    });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "上传失败" });
  }
});

/**
 * 上传图片到个人资产（用于用户主动上传保存）
 */
router.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const file = (req as any).file as { buffer: Buffer; mimetype: string; size: number } | undefined;
    if (!file) return res.status(400).json({ success: false, error: "缺少文件" });

    // 简单探测尺寸（跳过，由前端在表单里带 width/height；后续可装 image-size）
    const width = req.body?.width ? Number(req.body.width) : null;
    const height = req.body?.height ? Number(req.body.height) : null;

    const dto = await MediaAssetService.uploadAndCreate({
      userId,
      type: "image",
      source: "uploaded",
      body: file.buffer,
      mime: file.mimetype,
      width,
      height,
    });
    res.json({ success: true, data: dto });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "上传失败" });
  }
});

router.patch("/assets/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { name, tags, isFavorite } = req.body ?? {};
    const patch: any = {};
    if (name !== undefined) patch.name = name === null ? null : String(name).slice(0, 255);
    if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags.slice(0, 20).map(String) : null;
    if (isFavorite !== undefined) patch.isFavorite = !!isFavorite;
    const dto = await MediaAssetService.updateMeta(Number(req.params.id), userId, patch);
    if (!dto) return res.status(404).json({ success: false, error: "资产不存在" });
    res.json({ success: true, data: dto });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "更新失败" });
  }
});

router.post("/assets/batch-delete", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: "ids 不能为空" });
    }
    const count = await MediaAssetService.softDelete(
      ids.map(Number).filter(Number.isFinite),
      userId
    );
    res.json({ success: true, deleted: count });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "删除失败" });
  }
});

// =============== Prompts ===============

router.get("/prompts", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { sort, q, limit, offset } = req.query as Record<string, string>;
    const data = await PromptLibraryService.listUserPrompts({
      userId,
      sort: sort === "hot" ? "hot" : "recent",
      keyword: q,
      limit: parseInt0(limit, 30),
      offset: parseInt0(offset, 0),
    });
    res.json({ success: true, ...data });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "查询失败" });
  }
});

router.post("/prompts", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { content, name, tags, sourceJobId } = req.body ?? {};
    const dto = await PromptLibraryService.favorite({
      userId,
      content: String(content ?? ""),
      name: name ? String(name).slice(0, 255) : null,
      tags: Array.isArray(tags) ? tags.slice(0, 20).map(String) : null,
      sourceJobId: sourceJobId ? Number(sourceJobId) : null,
    });
    res.json({ success: true, data: dto });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "收藏失败" });
  }
});

router.patch("/prompts/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { name, tags } = req.body ?? {};
    const patch: any = {};
    if (name !== undefined) patch.name = name === null ? null : String(name).slice(0, 255);
    if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags.slice(0, 20).map(String) : null;
    const dto = await PromptLibraryService.updateMeta(Number(req.params.id), userId, patch);
    if (!dto) return res.status(404).json({ success: false, error: "提示词不存在" });
    res.json({ success: true, data: dto });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "更新失败" });
  }
});

router.delete("/prompts/:id", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const ok = await PromptLibraryService.unfavorite(Number(req.params.id), userId);
    if (!ok) return res.status(404).json({ success: false, error: "提示词不存在" });
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "删除失败" });
  }
});

router.post("/prompts/:id/use", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    await PromptLibraryService.incrementUseCount(Number(req.params.id), userId);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || "操作失败" });
  }
});

// =============== Providers ===============

router.get("/providers", async (_req: Request, res: Response) => {
  res.json({ success: true, data: describeProviders() });
});

export default router;

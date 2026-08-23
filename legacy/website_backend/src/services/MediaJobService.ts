/**
 * 媒体生成任务服务
 *
 * 核心职责：
 *   1. submitJob：创建任务 + 预扣点 + 写流水（事务三件套）
 *   2. markRunning：poller 成功 submit 第三方后调用
 *   3. markSucceeded：poller 拿到产物入 OSS 后调用（关联 output_asset_id）
 *   4. markFailed / markCancelled：失败 / 用户取消时退款（事务）
 *
 * 计费协议（与 BillingService 风格对齐）：
 *   - billing_transactions.type 用 'consume' 和 'refund'
 *   - ref_type='media_job' / 'media_job_refund'
 *   - ref_id=media_jobs.id
 */

import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool, { transaction } from "../db/mysql";
import OssService from "./storage/OssService";
import MediaAssetService from "./MediaAssetService";
import { estimatePoints, getActualPrice, getDefaultModel } from "./media/MediaPricing";
import { getProvider, isDryRun } from "./media";
import type { MediaKind } from "./media/MediaProvider";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface MediaJobRow extends RowDataPacket {
  id: number;
  user_id: number;
  kind: MediaKind;
  model_id: string;
  provider_name: string;
  prompt: string;
  negative_prompt: string | null;
  input_asset_id: number | null;
  input_asset_id_end: number | null;
  params: unknown;
  idempotency_key: string | null;
  status: JobStatus;
  provider_task_id: string | null;
  output_asset_id: number | null;
  error_msg: string | null;
  retry_count: number;
  estimated: number;
  consumed: number;
  refunded: number;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MediaJobDTO {
  id: number;
  kind: MediaKind;
  model_id: string;
  provider_name: string;
  prompt: string;
  negative_prompt: string | null;
  input_asset_id: number | null;
  input_asset_id_end: number | null;
  params: Record<string, unknown>;
  status: JobStatus;
  error_msg: string | null;
  output_asset_id: number | null;
  estimated: number;
  consumed: number;
  refunded: number;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

function parseParams(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return {};
}

export function toJobDTO(r: MediaJobRow): MediaJobDTO {
  return {
    id: r.id,
    kind: r.kind,
    model_id: r.model_id,
    provider_name: r.provider_name,
    prompt: r.prompt,
    negative_prompt: r.negative_prompt,
    input_asset_id: r.input_asset_id,
    input_asset_id_end: r.input_asset_id_end,
    params: parseParams(r.params),
    status: r.status,
    error_msg: r.error_msg,
    output_asset_id: r.output_asset_id,
    estimated: r.estimated,
    consumed: r.consumed,
    refunded: r.refunded,
    started_at: r.started_at,
    finished_at: r.finished_at,
    created_at: r.created_at,
  };
}

export interface SubmitJobInput {
  userId: number;
  kind: MediaKind;
  modelId?: string;       // 可选：不传按 kind 取默认
  prompt: string;
  negativePrompt?: string | null;
  inputAssetId?: number | null;
  inputAssetIdEnd?: number | null;
  params?: Record<string, unknown>;
  idempotencyKey?: string;
}

class MediaJobService {
  /**
   * 判断是否为视频类任务
   */
  private isVideoKind(kind: MediaKind): boolean {
    return kind === "t2v" || kind === "i2v" || kind === "flf2v";
  }

  /**
   * 根据 modelId 推断 kind
   * 规则：模型名中包含特定关键字时优先匹配
   */
  private inferKindFromModelId(modelId: string | undefined, fallbackKind: MediaKind): MediaKind {
    if (!modelId) return fallbackKind;
    const lower = modelId.toLowerCase();
    if (lower.includes("flf2v") || lower.includes("first-frame") || lower.includes("firstframe")) {
      return "flf2v";
    }
    if (lower.includes("i2v") || lower.includes("img2vid") || lower.includes("image2video") || lower.includes("image-to-video")) {
      return "i2v";
    }
    if (lower.includes("t2v") || lower.includes("text2video") || lower.includes("text-to-video")) {
      return "t2v";
    }
    if (lower.includes("i2i") || lower.includes("img2img") || lower.includes("image2image") || lower.includes("image-to-image")) {
      return "i2i";
    }
    if (lower.includes("t2i") || lower.includes("text2image") || lower.includes("text-to-image")) {
      return "t2i";
    }
    return fallbackKind;
  }

  /**
   * 从远程 URL 创建媒体资产（用于 reference_images 转首帧/尾帧）
   */
  private async createAssetFromUrl(
    userId: number,
    url: string,
    name?: string
  ): Promise<number> {
    const ossKey = OssService.buildKey({
      userId,
      kind: "upload",
      mime: "image/png",
    });
    const put = await OssService.putFromRemoteUrl({
      url,
      ossKey,
      mime: "image/png",
    });
    return await MediaAssetService.createAsset({
      userId,
      type: "image",
      source: "uploaded",
      ossKey: put.ossKey,
      mime: put.mime,
      sizeBytes: put.size,
    });
  }

  /**
   * 提交任务：事务里完成 [创建 job + 扣点 + 写流水] 三件事
   *
   * 返回的 job 状态为 pending，由 poller 负责调 Provider.submit
   */
  async submitJob(input: SubmitJobInput): Promise<MediaJobDTO> {
    const prompt = (input.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt 不能为空");
    if (prompt.length > 4000) throw new Error("prompt 超长（>4000）");

    // 从 params 中提取 reference_images，自动转为首帧/尾帧
    const params = input.params ?? {};
    let inputAssetId = input.inputAssetId ?? null;
    let inputAssetIdEnd = input.inputAssetIdEnd ?? null;

    // 视频任务：reference_images 中的图片自动转为首帧/尾帧
    // 1张图 = 首帧，2张图 = 首尾帧
    const refImages = (params.reference_images as string[]) ?? [];
    if (this.isVideoKind(input.kind) && refImages.length > 0 && !inputAssetId) {
      console.log(`[MediaJob:DEBUG] 从 reference_images 创建首帧/尾帧: ${refImages.length} 张`);
      // 第一张图作为首帧
      inputAssetId = await this.createAssetFromUrl(input.userId, refImages[0], "首帧");
      console.log(`[MediaJob:DEBUG] 首帧资产创建成功: id=${inputAssetId}`);

      if (refImages.length >= 2 && !inputAssetIdEnd) {
        // 第二张图作为尾帧
        inputAssetIdEnd = await this.createAssetFromUrl(input.userId, refImages[1], "尾帧");
        console.log(`[MediaJob:DEBUG] 尾帧资产创建成功: id=${inputAssetIdEnd}`);
      }

      // 更新 params：移除已转为首帧/尾帧的图片，保留剩余的作为参考图
      if (refImages.length > 2) {
        params.reference_images = refImages.slice(2);
      } else {
        delete params.reference_images;
      }
    }

    // 信任前端传来的 kind，但根据 inputAssetId 自动推断/调整
    let kind = input.kind;

    // 校验输入资产归属
    if (inputAssetId) {
      await this.assertAssetOwnership(inputAssetId, input.userId);
    }
    if (inputAssetIdEnd) {
      await this.assertAssetOwnership(inputAssetIdEnd, input.userId);
    }

    // 根据是否有输入图自动调整 kind
    if (kind === "t2v" && inputAssetId) {
      kind = inputAssetIdEnd ? "flf2v" : "i2v";
      console.log(`[MediaJob:DEBUG] 有输入图，自动调整 kind: t2v -> ${kind}`);
    }
    if ((kind === "i2v" || kind === "flf2v") && !inputAssetId) {
      console.log(`[MediaJob:DEBUG] 无输入图，自动调整 kind: ${kind} -> t2v`);
      kind = "t2v";
    }

    // FLF2V 必须有两张图
    if (kind === "flf2v" && (!inputAssetId || !inputAssetIdEnd)) {
      throw new Error("首尾帧任务必须提供 inputAssetId 和 inputAssetIdEnd");
    }
    // I2I / I2V 必须有输入图
    if ((kind === "i2i" || kind === "i2v") && !inputAssetId) {
      throw new Error(`${kind} 任务必须提供 inputAssetId`);
    }

    // 价格估算
    const def = getDefaultModel(kind);

    console.log(`[MediaJob:DEBUG] submitJob input.modelId=${input.modelId}, def.modelId=${def.modelId}, def.provider=${def.provider}`);

    const modelId = input.modelId ?? def.modelId;

    // 根据 kind 确定正确的 provider（视频类任务必须用 video provider）
    let providerName = def.provider;
    const dryRun = isDryRun();
    console.log(`[MediaJob:DEBUG] dryRun=${dryRun}`);

    if (dryRun) {
      providerName = "mock";
    } else if (input.modelId) {
      // 如果有传入 modelId，尝试从 marketplace 查询对应 provider
      try {
        const [rows] = await pool.execute<RowDataPacket[]>(
          `SELECT provider FROM model_library WHERE model_id = ? AND status = 1 AND is_visible = 1 LIMIT 1`,
          [input.modelId]
        );
        if (rows[0]?.provider) {
          providerName = rows[0].provider;
          console.log(`[MediaJob:DEBUG] 从数据库查询到 provider=${providerName} for modelId=${input.modelId}`);
        } else {
          console.warn(`[MediaJob:DEBUG] 未在数据库找到 modelId=${input.modelId}，使用默认 provider=${providerName}`);
        }
      } catch (e) {
        console.warn(`[MediaJob:DEBUG] 查询 model_library 失败:`, (e as Error).message);
      }
    }

    // 兼容性修正：旧数据可能把图片和视频 provider 都配成 "alibaba"
    // 视频类任务若 provider 是 alibaba，修正为 alibaba-video
    const VIDEO_KINDS: MediaKind[] = ["t2v", "i2v", "flf2v"];
    if (VIDEO_KINDS.includes(kind) && providerName === "alibaba") {
      providerName = "alibaba-video";
      console.log(`[MediaJob:DEBUG] 兼容性修正 provider: alibaba -> alibaba-video (视频类任务)`);
    }

    console.log(`[MediaJob:DEBUG] 最终使用 provider=${providerName}`);

    const { points } = await estimatePoints(modelId, kind, params);

    console.log(`[MediaJob:DEBUG] 估算点数=${points}`);

    // 幂等 key（DB 唯一约束兜底）
    const idemKey = input.idempotencyKey ?? null;
    if (idemKey) {
      const [existing] = await pool.execute<MediaJobRow[]>(
        `SELECT * FROM media_jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
        [input.userId, idemKey]
      );
      if (existing[0]) return toJobDTO(existing[0]);
    }

    return await transaction(async (conn) => {
      // 1. 余额校验 + 扣点（SELECT FOR UPDATE 防并发超扣）
      const [balRows] = await conn.execute<RowDataPacket[]>(
        `SELECT balance FROM user_users WHERE id = ? FOR UPDATE`,
        [input.userId]
      );
      const balance = Number(balRows[0]?.balance ?? 0);
      if (balance < points) {
        // 计算需要多少元（保留2位小数）
        const pointsPerYuan = Number(process.env.RECHARGE_POINTS_PER_YUAN) || 100000;
        const needYuan = (points / pointsPerYuan).toFixed(2);
        throw new Error(`生成当前视频大概需要 ${needYuan} 元，您的余额不足，请充值`);
      }

      await conn.execute(
        `UPDATE user_users SET balance = balance - ? WHERE id = ?`,
        [points, input.userId]
      );

      // 2. 创建 job
      const [jobR] = await conn.execute<ResultSetHeader>(
        `INSERT INTO media_jobs
          (user_id, kind, model_id, provider_name,
           prompt, negative_prompt,
           input_asset_id, input_asset_id_end, params,
           idempotency_key,
           status, estimated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          input.userId,
          kind,
          modelId,
          providerName,
          prompt,
          input.negativePrompt ?? null,
          inputAssetId,
          inputAssetIdEnd,
          JSON.stringify(params),
          idemKey,
          points,
        ]
      );
      const jobId = jobR.insertId;

      // 3. 写预扣流水
      const balanceAfter = balance - points;
      await conn.execute(
        `INSERT INTO billing_transactions
          (user_id, type, delta, balance_after, ref_type, ref_id, remark)
         VALUES (?, 'consume', ?, ?, 'media_job', ?, ?)`,
        [
          input.userId,
          -points,
          balanceAfter,
          jobId,
          `${kind} 生成预扣（${modelId}）`,
        ]
      );

      console.log(
        `[MediaJob] 创建 job=${jobId} user=${input.userId} kind=${kind} ` +
          `model=${modelId} provider=${providerName} 预扣=${points} 余额=${balanceAfter}`
      );

      const fresh = await this.findByIdInTxn(jobId, conn);
      return toJobDTO(fresh!);
    });
  }

  /** poller 调用：标记 pending → running，写第三方任务号 */
  async markRunning(jobId: number, providerTaskId: string): Promise<void> {
    await pool.execute(
      `UPDATE media_jobs
          SET status = 'running',
              provider_task_id = ?,
              started_at = COALESCE(started_at, NOW())
        WHERE id = ? AND status IN ('pending', 'running')`,
      [providerTaskId, jobId]
    );
  }

  /** poller 调用：成功完成 */
  async markSucceeded(
    jobId: number,
    outputAssetId: number,
    opts?: { usageTokens?: number }
  ): Promise<void> {
    await transaction(async (conn) => {
      const [rows] = await conn.execute<MediaJobRow[]>(
        `SELECT * FROM media_jobs WHERE id = ? FOR UPDATE`,
        [jobId]
      );
      const job = rows[0];
      if (!job) throw new Error(`markSucceeded: job ${jobId} 不存在`);
      if (job.status === "succeeded") return; // 幂等
      if (job.status === "failed" || job.status === "cancelled") {
        console.warn(`[MediaJob] 跳过 markSucceeded：job=${jobId} 状态已是 ${job.status}`);
        return;
      }

      // 根据分辨率、是否有视频输入、实际 token 数计算实际价格（点）
      const params = parseParams(job.params);
      const resolution = String(params.resolution || "720p").toLowerCase();
      // "含视频输入"指用户上传了视频作为输入（reference_videos），不是图片
      const hasVideoInput = !!(params.reference_videos as string[])?.length || !!(params.reference_video_url as string);
      const tokens = opts?.usageTokens ?? 0;
      const { points: actualPoints, breakdown } = getActualPrice(resolution, hasVideoInput, tokens);

      console.log(`[MediaJob] 实际扣费计算: ${breakdown} => ${actualPoints}点`);

      await conn.execute(
        `UPDATE media_jobs
            SET status = 'succeeded',
                output_asset_id = ?,
                consumed = ?,
                finished_at = NOW()
          WHERE id = ?`,
        [outputAssetId, actualPoints, jobId]
      );

      // 写 proxy_logs 记录（用于用量统计和账单展示）
      const latencyMs = job.started_at
        ? Math.round(Date.now() - new Date(job.started_at).getTime())
        : 0;
      try {
        await conn.execute(
          `INSERT INTO proxy_logs
            (user_id, token_id, token_name, channel_id, channel_name, model,
             prompt_tokens, completion_tokens, quota_consumed, latency_ms,
             status, error_msg, is_thinking, price_markup, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            job.user_id,           // user_id
            0,                     // token_id（媒体任务无 API Key）
            'media-studio',        // token_name
            0,                     // channel_id
            job.provider_name,     // channel_name
            job.model_id,          // model
            0,                     // prompt_tokens
            opts?.usageTokens ?? 0, // completion_tokens（第三方实际消耗）
            actualPoints,      // quota_consumed（实际价格，单位：点）
            latencyMs,             // latency_ms
            'success',             // status
            '',                    // error_msg
            0,                     // is_thinking
            1.0,                   // price_markup
            `media_job_${jobId}`,  // request_id
          ]
        );
        console.log(`[MediaJob] 📝 proxy_logs 已写入 job=${jobId} points=${actualPoints} tokens=${opts?.usageTokens ?? 0} latency=${latencyMs}ms`);
      } catch (logErr) {
        console.warn(`[MediaJob] proxy_logs 写入失败 job=${jobId}:`, (logErr as Error).message);
      }

      console.log(`[MediaJob] ✅ 成功 job=${jobId} output=${outputAssetId} consumed=${actualPoints}点`);
    });
  }

  /** poller / 路由调用：失败或取消时退款 */
  async markFailedAndRefund(
    jobId: number,
    errorMsg: string,
    reason: "failed" | "cancelled" = "failed"
  ): Promise<void> {
    await transaction(async (conn) => {
      const [rows] = await conn.execute<MediaJobRow[]>(
        `SELECT * FROM media_jobs WHERE id = ? FOR UPDATE`,
        [jobId]
      );
      const job = rows[0];
      if (!job) throw new Error(`markFailed: job ${jobId} 不存在`);
      if (job.status === "succeeded") {
        console.warn(`[MediaJob] 跳过 markFailed：job=${jobId} 已 succeeded`);
        return;
      }
      if (job.status === "failed" || job.status === "cancelled") return; // 幂等

      const refund = Number(job.estimated) - Number(job.refunded);
      if (refund > 0) {
        // 退款：用户余额 += refund
        await conn.execute(
          `UPDATE user_users SET balance = balance + ? WHERE id = ?`,
          [refund, job.user_id]
        );
        const [balRows] = await conn.execute<RowDataPacket[]>(
          `SELECT balance FROM user_users WHERE id = ? LIMIT 1`,
          [job.user_id]
        );
        const newBal = Number(balRows[0]?.balance ?? 0);

        await conn.execute(
          `INSERT INTO billing_transactions
            (user_id, type, delta, balance_after, ref_type, ref_id, remark)
           VALUES (?, 'refund', ?, ?, 'media_job_refund', ?, ?)`,
          [
            job.user_id,
            refund,
            newBal,
            jobId,
            `${job.kind} ${reason === "cancelled" ? "用户取消" : "生成失败"}退款（${job.model_id}）`,
          ]
        );

        await conn.execute(
          `UPDATE media_jobs SET refunded = ? WHERE id = ?`,
          [refund, jobId]
        );
        console.log(
          `[MediaJob] 💰 退款 job=${jobId} user=${job.user_id} +${refund} 余额=${newBal}`
        );
      }

      await conn.execute(
        `UPDATE media_jobs
            SET status = ?,
                error_msg = ?,
                finished_at = NOW()
          WHERE id = ?`,
        [reason, errorMsg.slice(0, 5000), jobId]
      );
    });
  }

  /** 用户主动取消 */
  async cancelByUser(jobId: number, userId: number): Promise<void> {
    const [rows] = await pool.execute<MediaJobRow[]>(
      `SELECT * FROM media_jobs WHERE id = ? AND user_id = ? LIMIT 1`,
      [jobId, userId]
    );
    const job = rows[0];
    if (!job) throw new Error("任务不存在或无权限");
    if (job.status === "succeeded") throw new Error("任务已完成，无法取消");
    if (job.status === "failed" || job.status === "cancelled") return;

    // 尝试通知 Provider 取消（best-effort）
    try {
      if (job.provider_task_id) {
        const p = getProvider(job.provider_name);
        if (p.cancel) await p.cancel(job.provider_task_id);
      }
    } catch (e) {
      console.warn(`[MediaJob] cancel 通知 provider 失败：`, (e as Error).message);
    }

    await this.markFailedAndRefund(jobId, "用户取消", "cancelled");
  }

  async findById(id: number, userId: number): Promise<MediaJobDTO | null> {
    const [rows] = await pool.execute<MediaJobRow[]>(
      `SELECT * FROM media_jobs WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId]
    );
    return rows[0] ? toJobDTO(rows[0]) : null;
  }

  /** 内部用（poller 等） */
  async findByIdSystem(id: number): Promise<MediaJobRow | null> {
    const [rows] = await pool.execute<MediaJobRow[]>(
      `SELECT * FROM media_jobs WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  }

  private async findByIdInTxn(id: number, conn: PoolConnection): Promise<MediaJobRow | null> {
    const [rows] = await conn.execute<MediaJobRow[]>(
      `SELECT * FROM media_jobs WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  }

  /** 用户的任务列表 */
  async listUserJobs(opts: {
    userId: number;
    kind?: MediaKind;
    status?: JobStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: MediaJobDTO[]; total: number }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    const offset = Math.max(0, opts.offset ?? 0);
    const conds = ["user_id = ?"];
    const params: any[] = [opts.userId];
    if (opts.kind) {
      conds.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.status) {
      conds.push("status = ?");
      params.push(opts.status);
    }
    const where = conds.join(" AND ");

    const [[countRow]] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM media_jobs WHERE ${where}`,
      params
    );
    const total = Number((countRow as any).c) || 0;

    const [rows] = await pool.execute<MediaJobRow[]>(
      `SELECT * FROM media_jobs
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return { items: rows.map(toJobDTO), total };
  }

  /** poller 用：拿到一批需要处理的任务 */
  async listRunningJobs(limit: number): Promise<MediaJobRow[]> {
    const [rows] = await pool.execute<MediaJobRow[]>(
      `SELECT * FROM media_jobs
        WHERE status IN ('pending', 'running')
        ORDER BY updated_at ASC
        LIMIT ${Math.max(1, Math.min(200, limit))}`
    );
    return rows;
  }

  private async assertAssetOwnership(assetId: number, userId: number): Promise<void> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT user_id, is_deleted FROM media_assets WHERE id = ? LIMIT 1`,
      [assetId]
    );
    const r = rows[0];
    if (!r) throw new Error(`输入资产 ${assetId} 不存在`);
    if (r.user_id !== userId) throw new Error(`无权使用资产 ${assetId}`);
    if (r.is_deleted) throw new Error(`资产 ${assetId} 已删除`);
  }

  /** 为输入资产生成可被第三方拉取的签名 URL（poller 调 Provider.submit 前调用） */
  async resolveInputAssets(job: MediaJobRow): Promise<{
    inputAsset: any | null;
    inputAssetEnd: any | null;
  }> {
    const fetchOne = async (id: number | null) => {
      if (!id) return null;
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT id, oss_key, mime, width, height FROM media_assets WHERE id = ? LIMIT 1`,
        [id]
      );
      const r = rows[0];
      if (!r) return null;
      return {
        assetId: Number(r.id),
        signedUrl: await OssService.getSignedUrl(r.oss_key, 3600),
        mime: r.mime,
        width: r.width,
        height: r.height,
      };
    };
    const [a, b] = await Promise.all([
      fetchOne(job.input_asset_id),
      fetchOne(job.input_asset_id_end),
    ]);
    return { inputAsset: a, inputAssetEnd: b };
  }
}

export default new MediaJobService();

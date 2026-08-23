/**
 * 媒体任务 poller —— 后台常驻 worker
 *
 * 每 N 秒扫一次 status IN ('pending','running') 的任务：
 *   - pending：调 Provider.submit 拿 providerTaskId，转 running
 *   - running：调 Provider.query
 *       - succeeded：把第三方 URL 拉到 OSS、写 media_assets、markSucceeded
 *       - failed：markFailedAndRefund
 *       - running：继续等
 *   - 超时（created_at + JOB_TIMEOUT_MS < now）：强制 failed + 退款
 *
 * 使用 Redis 分布式锁防止多实例竞争处理同一任务。
 *
 * 启动方式：在 backend/src/index.ts 里 startMediaPoller()
 */

import MediaJobService from "../MediaJobService";
import MediaAssetService from "../MediaAssetService";
import OssService from "../storage/OssService";
import { getProvider } from "./index";
import type { MediaJobRow } from "../MediaJobService";
import { tryLock } from "../../utils/redis-lock";

const POLL_INTERVAL_MS = Number(process.env.MEDIA_POLL_INTERVAL_MS) || 5000;
const JOB_TIMEOUT_MS = Number(process.env.MEDIA_JOB_TIMEOUT_MS) || 600_000;
const BATCH_SIZE = Number(process.env.MEDIA_POLL_BATCH_SIZE) || 20;

let _timer: NodeJS.Timeout | null = null;
let _running = false;

export function startMediaPoller() {
  if (_timer) {
    console.warn("[MediaPoller] already started");
    return;
  }
  console.log(
    `[MediaPoller] 启动：间隔 ${POLL_INTERVAL_MS}ms，单轮批量 ${BATCH_SIZE}，任务超时 ${JOB_TIMEOUT_MS}ms`
  );
  _timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // 立即跑一次（不阻塞启动）
  setTimeout(() => void tick(), 1000);
}

export function stopMediaPoller() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log("[MediaPoller] 已停止");
  }
}

async function tick() {
  if (_running) {
    console.log("[MediaPoller:DEBUG] tick 跳过，上一轮仍在运行");
    return;
  }
  _running = true;
  console.log("[MediaPoller:DEBUG] tick 开始扫描任务...");
  try {
    const jobs = await MediaJobService.listRunningJobs(BATCH_SIZE);
    console.log(`[MediaPoller:DEBUG] 发现 ${jobs.length} 个运行中任务:`, jobs.map(j => `job=${j.id} status=${j.status} provider=${j.provider_name}`));
    if (jobs.length === 0) return;

    // 并发处理，但单个失败不影响其他
    await Promise.allSettled(jobs.map(processJob));
  } catch (e) {
    console.error("[MediaPoller:DEBUG] tick error:", (e as Error).message);
  } finally {
    _running = false;
    console.log("[MediaPoller:DEBUG] tick 结束");
  }
}

async function processJob(job: MediaJobRow): Promise<void> {
  // 尝试获取分布式锁，锁超时时间为 2 分钟
  const lock = await tryLock(`media_job:${job.id}`, 120_000);
  if (!lock) {
    console.log(`[MediaPoller:DEBUG] job=${job.id} 未获取到锁，跳过（其他实例正在处理）`);
    return;
  }

  try {
    console.log(`[MediaPoller:DEBUG] 处理 job=${job.id} status=${job.status} provider=${job.provider_name} model=${job.model_id}`);

    // 超时检测
    const ageMs = Date.now() - new Date(job.created_at).getTime();
    if (ageMs > JOB_TIMEOUT_MS) {
      console.warn(`[MediaPoller:DEBUG] 任务 ${job.id} 超时 (${ageMs}ms)，标记 failed`);
      await MediaJobService.markFailedAndRefund(job.id, `任务超时（${Math.round(ageMs / 1000)}s）`);
      return;
    }

    console.log(`[MediaPoller:DEBUG] 获取 provider: ${job.provider_name}`);
    const provider = getProvider(job.provider_name);
    console.log(`[MediaPoller:DEBUG] provider 实例: ${provider.name}, supports=[${provider.supports.join(",")}], configured=${provider.isConfigured()}`);

    if (job.status === "pending") {
      console.log(`[MediaPoller:DEBUG] job=${job.id} 处于 pending，准备提交到 provider`);
      // submit
      const { inputAsset, inputAssetEnd } = await MediaJobService.resolveInputAssets(job);
      console.log(`[MediaPoller:DEBUG] job=${job.id} inputAsset=${inputAsset?.assetId ?? "null"} inputAssetEnd=${inputAssetEnd?.assetId ?? "null"}`);

      console.log(`[MediaPoller:DEBUG] job=${job.id} 调用 provider.submit...`);
      const submit = await provider.submit({
        jobId: job.id,
        userId: job.user_id,
        kind: job.kind,
        modelId: job.model_id,
        prompt: job.prompt,
        negativePrompt: job.negative_prompt,
        inputAsset,
        inputAssetEnd,
        params: parseParams(job.params),
      });
      console.log(`[MediaPoller:DEBUG] job=${job.id} provider.submit 返回 providerTaskId=${submit.providerTaskId}`);

      await MediaJobService.markRunning(job.id, submit.providerTaskId);
      console.log(`[MediaPoller:DEBUG] job=${job.id} 已标记为 running`);
      return;
    }

    if (job.status === "running") {
      console.log(`[MediaPoller:DEBUG] job=${job.id} 处于 running，准备查询 provider`);
      if (!job.provider_task_id) {
        console.warn(`[MediaPoller:DEBUG] job=${job.id} running 但缺 provider_task_id，标记失败`);
        await MediaJobService.markFailedAndRefund(job.id, "running 但缺 provider_task_id（异常）");
        return;
      }

      console.log(`[MediaPoller:DEBUG] job=${job.id} 调用 provider.query(${job.provider_task_id}, ${job.model_id})...`);
      const q = await provider.query(job.provider_task_id, job.model_id);
      console.log(`[MediaPoller:DEBUG] job=${job.id} provider.query 返回 status=${q.status}${q.usage ? ` tokens=${q.usage.completionTokens}` : ''}`);

      if (q.status === "running") {
        console.log(`[MediaPoller:DEBUG] job=${job.id} 仍在 running，继续等待`);
        return;
      }

      if (q.status === "failed") {
        console.warn(`[MediaPoller:DEBUG] job=${job.id} provider 返回 failed，error=${q.error || "unknown"}`);
        await MediaJobService.markFailedAndRefund(job.id, q.error || "第三方任务失败");
        return;
      }

      // succeeded：把产物拉到 OSS + 入库
      const urls = q.outputUrls ?? [];
      if (urls.length === 0) {
        await MediaJobService.markFailedAndRefund(job.id, "succeeded 但缺 outputUrls");
        return;
      }

      const isVideo = job.kind === "t2v" || job.kind === "i2v" || job.kind === "flf2v";
      const assetType = isVideo ? "video" : "image";

      // 产物入 OSS + media_assets
      const firstUrl = urls[0];
      const mime = isVideo ? "video/mp4" : "image/png";
      const ossKey = OssService.buildKey({
        userId: job.user_id,
        kind: isVideo ? "video" : "image",
        mime,
      });
      const put = await OssService.putFromRemoteUrl({ url: firstUrl, ossKey, mime });

      // 视频可选封面
      let thumbnailKey: string | null = null;
      if (isVideo && q.thumbnailUrl) {
        thumbnailKey = OssService.buildKey({
          userId: job.user_id,
          kind: "thumbnail",
          mime: "image/jpeg",
        });
        try {
          await OssService.putFromRemoteUrl({
            url: q.thumbnailUrl,
            ossKey: thumbnailKey,
            mime: "image/jpeg",
          });
        } catch (e) {
          console.warn(`[MediaPoller] 封面图拉取失败 job=${job.id}:`, (e as Error).message);
          thumbnailKey = null;
        }
      }

      const assetId = await MediaAssetService.createAsset({
        userId: job.user_id,
        type: assetType,
        source: "generated",
        ossKey: put.ossKey,
        mime: put.mime,
        sizeBytes: put.size,
        width: q.outputMeta?.width ?? null,
        height: q.outputMeta?.height ?? null,
        durationMs: q.outputMeta?.durationMs ?? null,
        thumbnailOssKey: thumbnailKey,
        relatedJobId: job.id,
      });

      // 多张图（n>1）：依次入库为额外资产
      for (let i = 1; i < urls.length; i++) {
        const extraKey = OssService.buildKey({
          userId: job.user_id,
          kind: isVideo ? "video" : "image",
          mime,
        });
        try {
          const extra = await OssService.putFromRemoteUrl({
            url: urls[i],
            ossKey: extraKey,
            mime,
          });
          await MediaAssetService.createAsset({
            userId: job.user_id,
            type: assetType,
            source: "generated",
            ossKey: extra.ossKey,
            mime: extra.mime,
            sizeBytes: extra.size,
            width: q.outputMeta?.width ?? null,
            height: q.outputMeta?.height ?? null,
            relatedJobId: job.id,
          });
        } catch (e) {
          console.warn(`[MediaPoller] 多产物第 ${i} 张失败 job=${job.id}:`, (e as Error).message);
        }
      }

      await MediaJobService.markSucceeded(job.id, assetId, {
        usageTokens: q.usage?.completionTokens,
      });
    }
  } catch (e) {
    // submit/query 异常：根据重试次数决定退还还是继续
    const msg = (e as Error).message || (typeof e === 'object' ? JSON.stringify(e) : String(e));
    console.error(`[MediaPoller:DEBUG] 处理 job=${job.id} 异常：`, msg, e);
    console.error(`[MediaPoller:DEBUG] job=${job.id} retry_count=${job.retry_count}`);
    if (job.retry_count >= 2) {
      console.error(`[MediaPoller:DEBUG] job=${job.id} 重试 ${job.retry_count} 次仍失败，标记 failed`);
      await MediaJobService.markFailedAndRefund(job.id, `重试 ${job.retry_count} 次仍失败：${msg}`);
    } else {
      // 简单累加 retry_count，下轮重试
      try {
        const pool = (await import("../../db/mysql")).default;
        await pool.execute(
          `UPDATE media_jobs SET retry_count = retry_count + 1, error_msg = ? WHERE id = ?`,
          [msg.slice(0, 500), job.id]
        );
        console.log(`[MediaPoller:DEBUG] job=${job.id} retry_count 增加到 ${job.retry_count + 1}`);
      } catch {/* ignore */}
    }
  } finally {
    // 释放分布式锁
    await lock.unlock();
  }
}

function parseParams(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return {};
}

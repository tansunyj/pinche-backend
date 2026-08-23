/**
 * MockProvider —— dry-run 假 provider
 *
 * 不调任何第三方 API、不需要任何凭证。
 * 提交即立刻"完成"（在内存里挂个 timer，模拟 3-8s 延迟），
 * 返回一张 picsum.photos 占位图或 sample-videos 占位视频 URL。
 *
 * 用途：
 *   - 本地开发联调（无需通义万相/可灵 API Key）
 *   - 单元测试
 *   - 演示环境
 *
 * 启用方式：环境变量 MEDIA_DRY_RUN=true，或模型卡片的 provider_name='mock'
 */

import crypto from "crypto";
import {
  BaseMediaProvider,
  type MediaJobRequest,
  type MediaSubmitResult,
  type MediaQueryResult,
  type MediaKind,
} from "./MediaProvider";

interface MockTask {
  jobId: number;
  kind: MediaKind;
  params: Record<string, unknown>;
  /** 这个时间点之后 query 会返回 succeeded */
  doneAt: number;
  cancelled: boolean;
}

export class MockProvider extends BaseMediaProvider {
  readonly name = "mock";
  readonly supports: ReadonlyArray<MediaKind> = ["t2i", "i2i", "t2v", "i2v", "flf2v"];

  /** 假任务在内存里，进程重启即丢失（dry-run 用足够） */
  private tasks = new Map<string, MockTask>();

  isConfigured(): boolean {
    return true;
  }

  async submit(req: MediaJobRequest): Promise<MediaSubmitResult> {
    const providerTaskId = `mock_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    // 视频任务模拟 6-10 秒，图片任务模拟 3-5 秒
    const isVideo = req.kind === "t2v" || req.kind === "i2v" || req.kind === "flf2v";
    const delayMs = isVideo
      ? 6000 + Math.floor(Math.random() * 4000)
      : 3000 + Math.floor(Math.random() * 2000);

    this.tasks.set(providerTaskId, {
      jobId: req.jobId,
      kind: req.kind,
      params: req.params,
      doneAt: Date.now() + delayMs,
      cancelled: false,
    });

    this.log(
      `submit job=${req.jobId} kind=${req.kind} model=${req.modelId} task=${providerTaskId} delay=${delayMs}ms`
    );
    return { providerTaskId };
  }

  async query(providerTaskId: string, _modelId?: string): Promise<MediaQueryResult> {
    const task = this.tasks.get(providerTaskId);
    if (!task) {
      return { status: "failed", error: "mock task not found (process restarted?)" };
    }
    if (task.cancelled) {
      return { status: "failed", error: "cancelled by user" };
    }
    if (Date.now() < task.doneAt) {
      return { status: "running" };
    }

    // 完成：根据任务种类返回不同占位媒体
    const isVideo = task.kind === "t2v" || task.kind === "i2v" || task.kind === "flf2v";
    const seed = Math.floor(Math.random() * 100000);

    if (isVideo) {
      // 公开的占位视频（sample-videos.com 提供 720p 短片）
      return {
        status: "succeeded",
        outputUrls: [
          "https://sample-videos.com/video321/mp4/720/big_buck_bunny_720p_1mb.mp4",
        ],
        thumbnailUrl: `https://picsum.photos/seed/${seed}/1280/720`,
        outputMeta: { width: 1280, height: 720, durationMs: 5000 },
      };
    }

    // 图片任务：返回 picsum 随机图，尺寸尽量贴近请求参数
    const width = Number(task.params.width) || 1024;
    const height = Number(task.params.height) || 1024;
    return {
      status: "succeeded",
      outputUrls: [`https://picsum.photos/seed/${seed}/${width}/${height}`],
      outputMeta: { width, height },
    };
  }

  async cancel(providerTaskId: string): Promise<void> {
    const task = this.tasks.get(providerTaskId);
    if (task) task.cancelled = true;
  }
}

export default new MockProvider();

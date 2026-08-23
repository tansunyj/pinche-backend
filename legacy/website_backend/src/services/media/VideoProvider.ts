/**
 * Video Provider（视频生成）
 *
 * 职责：调用 relay server 的内部接口进行视频生成（T2V/I2V/FLF2V）
 *
 * 调用链路：
 *   poller -> VideoProvider -> relay server /internal/v1/videos/generations -> DashScope
 *
 * 环境变量：
 *   RELAY_SERVER_URL - relay server 地址（默认 http://localhost:3002）
 *   JWT_SECRET - 用于签发服务间调用的 JWT Token
 */

import {
  BaseMediaProvider,
  type MediaJobRequest,
  type MediaSubmitResult,
  type MediaQueryResult,
  type MediaKind,
} from "./MediaProvider";
import { signToken } from "../../utils/auth";

const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || "http://localhost:3002";

export class VideoProvider extends BaseMediaProvider {
  readonly name = "alibaba-video";
  readonly supports: MediaKind[] = ["t2v", "i2v", "flf2v"];

  isConfigured(): boolean {
    if (!process.env.JWT_SECRET) {
      console.warn("[Video] JWT_SECRET 未配置");
      return false;
    }
    return true;
  }

  /**
   * 根据 modelId 推断 kind
   * 规则：模型名中包含特定关键字时优先匹配
   */
  private inferKindFromModelId(modelId: string, fallbackKind: MediaKind): MediaKind {
    const lower = modelId.toLowerCase();
    if (lower.includes("flf2v") || lower.includes("first-frame")) {
      return "flf2v";
    }
    if (lower.includes("i2v") || lower.includes("img2vid") || lower.includes("image2video")) {
      return "i2v";
    }
    if (lower.includes("t2v") || lower.includes("text2video")) {
      return "t2v";
    }
    return fallbackKind;
  }

  /**
   * 提交视频生成任务到 relay server
   */
  async submit(req: MediaJobRequest): Promise<MediaSubmitResult> {
    console.log(`[Video] 提交任务 jobId=${req.jobId}, modelId=${req.modelId}, kind=${req.kind}`);

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET 未配置");
    }

    // 使用后端传来的 kind，不再强制根据模型名校正
    // 后端 MediaJobService 已经根据是否有 inputAsset 正确处理了 kind
    const kind = req.kind;
    const modelId = req.modelId;

    // 如果最终是 i2v/flf2v 但没有输入图，报错
    if ((kind === "i2v" || kind === "flf2v") && !req.inputAsset?.signedUrl) {
      throw new Error(`${kind} 任务需要提供输入图片（首帧）`);
    }

    // 动态签发 JWT Token
    const serviceToken = signToken(
      { userId: 0, email: 'service@silievo.com', userType: 2, service: 'silievo-site' },
      process.env.JWT_SECRET,
      { expiresIn: '365d' }
    );

    const params = req.params || {};
    const aspect = (params.aspect as string) || "16:9";
    const duration = (params.duration as number) || 5;
    const resolution = (params.resolution as string) || "720P";

    // 构建请求体
    const requestBody: Record<string, any> = {
      model: modelId,
      prompt: req.prompt,
      aspect: aspect,
      duration: duration,
      resolution: resolution,
    };

    // I2V/FLF2V 需要输入图片
    if (kind === "i2v" && req.inputAsset?.signedUrl) {
      requestBody.images = [req.inputAsset.signedUrl];
      console.log(`[Video] I2V 模式，首帧图片: ${req.inputAsset.signedUrl.slice(0, 80)}...`);
    }

    if (kind === "flf2v") {
      if (req.inputAsset?.signedUrl) {
        requestBody.images = [req.inputAsset.signedUrl];
        console.log(`[Video] FLF2V 模式，首帧图片: ${req.inputAsset.signedUrl.slice(0, 80)}...`);
      }
      if (req.inputAssetEnd?.signedUrl) {
        requestBody.images = requestBody.images || [];
        requestBody.images.push(req.inputAssetEnd.signedUrl);
        console.log(`[Video] FLF2V 模式，尾帧图片: ${req.inputAssetEnd.signedUrl.slice(0, 80)}...`);
      }
    }

    const res = await fetch(`${RELAY_SERVER_URL}/internal/v1/videos/generations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceToken}`,
        "Content-Type": "application/json",
        "X-Request-Id": String(req.jobId),
      },
      body: JSON.stringify(requestBody),
    });

    const data = await res.json() as {
      success?: boolean;
      data?: {
        task_id?: string;
        status?: "succeeded" | "failed" | "running" | "PENDING";
        output_urls?: string[];
      };
      error?: { message?: string };
    };

    if (!res.ok || !data.success) {
      throw new Error(data.error?.message || `Relay Server 错误 (${res.status})`);
    }

    const taskId = data.data?.task_id;
    if (!taskId) {
      throw new Error("relay server 返回中没有 task_id");
    }

    console.log(`[Video] 任务已创建: ${taskId}, 状态: ${data.data?.status}`);
    return { providerTaskId: taskId };
  }

  /**
   * 查询任务状态
   */
  async query(providerTaskId: string, modelId?: string): Promise<MediaQueryResult> {
    if (!modelId) {
      return { status: "running" };
    }

    // 动态签发 JWT Token
    const serviceToken = signToken(
      { userId: 0, email: 'service@silievo.com', userType: 2, service: 'silievo-site' },
      process.env.JWT_SECRET!,
      { expiresIn: '365d' }
    );

    const res = await fetch(
      `${RELAY_SERVER_URL}/internal/v1/videos/generations/${providerTaskId}?model=${encodeURIComponent(modelId)}`,
      {
        headers: {
          "Authorization": `Bearer ${serviceToken}`,
        },
      }
    );

    if (!res.ok) {
      return { status: "running" };
    }

    const data = await res.json() as {
      success?: boolean;
      data?: {
        status?: "succeeded" | "failed" | "running";
        output_urls?: string[];
        thumbnail_url?: string;
        error?: string;
      };
    };

    if (!data.success || !data.data) {
      return { status: "running" };
    }

    const status = data.data.status;
    if (status === "succeeded") {
      return {
        status: "succeeded",
        outputUrls: data.data.output_urls || [],
        thumbnailUrl: data.data.thumbnail_url,
      };
    }
    if (status === "failed") {
      return { status: "failed", error: data.data.error || "任务失败" };
    }
    return { status: "running" };
  }

  async cancel(_providerTaskId: string): Promise<void> {
    // DashScope 未提供取消接口
  }
}

// 单例导出
export default new VideoProvider();

/**
 * WanX Provider（通义万相）
 *
 * 职责：仅作为 HTTP 客户端，调用 relay server 的内部接口
 * 所有代理逻辑（channel 解析、upstream 调用）都在 relay server 中处理
 *
 * 调用链路：
 *   poller -> WanxProvider -> relay server /internal/v1/images/generations -> DashScope
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

export class WanxProvider extends BaseMediaProvider {
  readonly name = "alibaba";
  readonly supports: MediaKind[] = ["t2i", "i2i"];

  isConfigured(): boolean {
    if (!process.env.JWT_SECRET) {
      console.warn("[WanX] JWT_SECRET 未配置");
      return false;
    }
    return true;
  }

  /**
   * 提交图片生成任务到 relay server
   */
  async submit(req: MediaJobRequest): Promise<MediaSubmitResult> {
    console.log(`[WanX] 提交任务 jobId=${req.jobId}, modelId=${req.modelId}`);
    console.log(`[WanX] 参数: n=${req.params?.n}, aspect=${req.params?.aspect}`);

    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET 未配置");
    }

    // 动态签发 JWT Token
    const serviceToken = signToken(
      { userId: 0, email: 'service@silievo.com', userType: 2, service: 'silievo-site' },
      process.env.JWT_SECRET,
      { expiresIn: '365d' }
    );

    const n = Math.min(Math.max(Number(req.params?.n) || 1, 1), 4);
    console.log(`[WanX] 最终传递的 n=${n}`);

    // 构建请求体：支持 I2I（图生图）
    const requestBody: Record<string, any> = {
      model: req.modelId,
      prompt: req.prompt,
      aspect: (req.params?.aspect as string) || "1:1",
      n: Math.min(Math.max(Number(req.params?.n) || 1, 1), 4),
    };

    // 如果有输入图片（I2I），传递图片 URL
    if (req.inputAsset?.signedUrl) {
      requestBody.images = [req.inputAsset.signedUrl];
      console.log(`[WanX] I2I 模式，图片1: ${req.inputAsset.signedUrl.slice(0, 80)}...`);
    }
    if (req.inputAssetEnd?.signedUrl) {
      requestBody.images = requestBody.images || [];
      requestBody.images.push(req.inputAssetEnd.signedUrl);
      console.log(`[WanX] I2I 模式，图片2: ${req.inputAssetEnd.signedUrl.slice(0, 80)}...`);
    }

    const res = await fetch(`${RELAY_SERVER_URL}/internal/v1/images/generations`, {
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

    console.log(`[WanX] 任务已创建: ${taskId}, 状态: ${data.data?.status}`);
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
      `${RELAY_SERVER_URL}/internal/v1/images/generations/${providerTaskId}?model=${encodeURIComponent(modelId)}`,
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
        error?: string;
      };
    };

    if (!data.success || !data.data) {
      return { status: "running" };
    }

    const status = data.data.status;
    if (status === "succeeded") {
      return { status: "succeeded", outputUrls: data.data.output_urls || [] };
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

export default new WanxProvider();
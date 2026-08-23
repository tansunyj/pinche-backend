/**
 * VolcVideoProvider - 火山引擎 Seedance 视频生成（官方 API）
 *
 * 职责：直接调用火山引擎官方 API 进行视频生成（T2V/I2V）
 *
 * 调用链路：
 *   poller -> VolcVideoProvider -> ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
 *
 * 环境变量：
 *   ARK_API_KEY - 火山引擎 API Key
 *   ARK_BASE_URL - 火山引擎 Base URL (默认 https://ark.cn-beijing.volces.com)
 *   ARK_TIMEOUT_MS - 超时时间 (默认 300000ms)
 */

import {
  BaseMediaProvider,
  type MediaJobRequest,
  type MediaSubmitResult,
  type MediaQueryResult,
  type MediaKind,
} from "./MediaProvider";

const BASE_URL = "https://ark.cn-beijing.volces.com";
const TIMEOUT_MS = Number(process.env.ARK_TIMEOUT_MS) || 300000;

/**
 * 火山引擎官方模型 ID 映射
 *
 * 注意：火山引擎 API 的 Model ID 格式为 "doubao-seedance-{版本}-{日期}"（横杠+日期版本号），
 * 不是计费页面的产品名格式（如 doubao-seedance-2.0-mini）。
 * 实际 Model ID 需在火山引擎控制台 → 模型开通页面查看。
 * 参考：https://www.volcengine.com/docs/82379/1330310
 *
 * 如果你在控制台开通了不同版本的模型，请更新此映射。
 */
const MODEL_MAPPING: Record<string, string> = {
  "seedance-2-0": "doubao-seedance-2-0-260128",
  "seedance-2-0-fast": "doubao-seedance-2-0-fast-250615",
  "seedance-2-0-mini": "doubao-seedance-2-0-mini-250615",
};

/** 火山引擎提交任务响应 */
interface ArkSubmitResponse {
  id?: string;
  status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  error?: {
    code?: string;
    message?: string;
  };
}

/** 火山引擎查询任务响应 */
interface ArkQueryResponse {
  id?: string;
  status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  model?: string;
  content?: {
    video_url?: string;
    last_frame_url?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
  resolution?: string;
  ratio?: string;
  duration?: number;
  generate_audio?: boolean;
  usage?: {
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class VolcVideoProvider extends BaseMediaProvider {
  readonly name = "volcengine";
  readonly supports: MediaKind[] = ["t2v", "i2v"];

  isConfigured(): boolean {
    if (!process.env.ARK_API_KEY) {
      this.warn("ARK_API_KEY 未配置");
      return false;
    }
    return true;
  }

  /**
   * 获取官方模型 ID
   */
  private getOfficialModelId(modelId: string): string {
    return MODEL_MAPPING[modelId] || modelId;
  }

  /**
   * 判断是否为 Seedance Mini 模型
   */
  private isMiniModel(modelId: string): boolean {
    return modelId.includes("mini");
  }

  /**
   * 构建火山引擎官方请求体
   * 参考文档: https://www.volcengine.com/docs/82379/1520757
   */
  private buildRequestBody(req: MediaJobRequest): Record<string, unknown> {
    const params = req.params || {};
    const officialModelId = this.getOfficialModelId(req.modelId);

    // 基础参数
    const aspect = (params.aspect as string) || "16:9";
    // Seedance 2.0 系列 duration 范围 [4, 15]，最小 4 秒
    let duration = (params.duration as number) || 5;
    if (duration < 4) duration = 4;
    if (duration > 15) duration = 15;
    const resolution = (params.resolution as string) || "720p";
    const generateAudio = params.generate_audio !== false; // 默认 true

    // 构建 content 数组（官方 API 格式）
    const content: Array<Record<string, unknown>> = [];

    // 1. 文本提示词
    if (req.prompt) {
      content.push({
        type: "text",
        text: req.prompt,
      });
    }

    // 2. 参考图片（多图参考，根据数量自动判断模式）
    //    - 1 张 → 首帧生视频 (first_frame)
    //    - 2 张 → 首尾帧生视频 (first_frame + last_frame)
    //    - 3~9 张 → 多模态参考 (reference_image)
    const referenceImages = Array.isArray(params.reference_images)
      ? (params.reference_images as string[]).filter(Boolean)
      : (req.inputAsset?.signedUrl ? [req.inputAsset.signedUrl] : []);
    if (referenceImages.length > 0) {
      if (referenceImages.length === 1) {
        // 首帧生视频
        content.push({
          type: "image_url",
          image_url: { url: referenceImages[0] },
          role: "first_frame",
        });
      } else if (referenceImages.length === 2) {
        // 首尾帧生视频
        content.push({
          type: "image_url",
          image_url: { url: referenceImages[0] },
          role: "first_frame",
        });
        content.push({
          type: "image_url",
          image_url: { url: referenceImages[1] },
          role: "last_frame",
        });
      } else {
        // 多模态参考（3~9 张，全部 reference_image）
        for (const url of referenceImages.slice(0, 9)) {
          content.push({
            type: "image_url",
            image_url: { url },
            role: "reference_image",
          });
        }
      }
    }

    // 3. 人像库引用（asset_uri，保留兼容旧逻辑）
    const assetUri = params.asset_uri as string | undefined;
    if (assetUri) {
      const assetType = params.asset_type as string | undefined;
      if (assetType === "Video" || assetType === "video") {
        // 真人视频素材
        content.push({
          type: "video_url",
          video_url: { url: assetUri },
          role: "reference_video",
        });
      } else {
        // 图片素材
        content.push({
          type: "image_url",
          image_url: { url: assetUri },
          role: "reference_image",
        });
      }
    }

    // 4. 参考视频（最多 3 个，Mini 模型不支持）
    const referenceVideos = Array.isArray(params.reference_videos)
      ? (params.reference_videos as string[]).filter(Boolean)
      : [];
    const singleReferenceVideoUrl = params.reference_video_url as string | undefined;
    const allReferenceVideos = singleReferenceVideoUrl
      ? [singleReferenceVideoUrl, ...referenceVideos]
      : referenceVideos;
    if (allReferenceVideos.length > 0 && !this.isMiniModel(req.modelId)) {
      for (const url of allReferenceVideos.slice(0, 3)) {
        content.push({
          type: "video_url",
          video_url: { url },
          role: "reference_video",
        });
      }
    }

    // 5. 参考音频（最多 3 个，Mini 模型不支持）
    const referenceAudios = Array.isArray(params.reference_audios)
      ? (params.reference_audios as string[]).filter(Boolean)
      : [];
    const singleReferenceAudioUrl = params.reference_audio_url as string | undefined;
    const allReferenceAudios = singleReferenceAudioUrl
      ? [singleReferenceAudioUrl, ...referenceAudios]
      : referenceAudios;
    if (allReferenceAudios.length > 0 && !this.isMiniModel(req.modelId)) {
      for (const url of allReferenceAudios.slice(0, 3)) {
        content.push({
          type: "audio_url",
          audio_url: { url },
          role: "reference_audio",
        });
      }
    }

    // 构建请求体（严格遵循官方 API 文档格式）
    const body: Record<string, unknown> = {
      model: officialModelId,
      content,
      ratio: aspect,
      duration,
      generate_audio: generateAudio,
      watermark: false,
    };

    // Mini 模型不支持 1080p，只支持 480p 和 720p
    if (this.isMiniModel(req.modelId)) {
      if (resolution !== "480p") {
        body.resolution = "720p"; // mini 默认 720p
      } else {
        body.resolution = "480p";
      }
    } else {
      body.resolution = resolution.toLowerCase();
    }

    // Mini 模型不支持参考音频/视频，已在上面过滤

    return body;
  }

  /**
   * 提交视频生成任务到火山引擎官方 API
   */
  async submit(req: MediaJobRequest): Promise<MediaSubmitResult> {
    this.log(`提交任务 jobId=${req.jobId}, modelId=${req.modelId}, kind=${req.kind}`);

    const apiKey = process.env.ARK_API_KEY;
    if (!apiKey) {
      throw new Error("ARK_API_KEY 未配置");
    }

    // I2V 需要输入图或人像库
    if (req.kind === "i2v" && !req.inputAsset?.signedUrl && !req.params?.asset_uri) {
      throw new Error("i2v 任务需要提供输入图片或人像库引用");
    }

    const requestBody = this.buildRequestBody(req);

    const url = `${BASE_URL}/api/v3/contents/generations/tasks`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // ===== 详细请求日志 =====
    this.log(`===== 请求详情 =====`);
    this.log(`目标地址: POST ${url}`);
    this.log(`请求头: ${JSON.stringify(headers, null, 2)}`);
    this.log(`API Key (前8位): ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
    this.log(`请求体: ${JSON.stringify(requestBody, null, 2)}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // ===== 详细响应日志 =====
      this.log(`===== 响应详情 =====`);
      this.log(`状态码: ${res.status} ${res.statusText}`);

      const rawBody = await res.text();
      this.log(`响应体(原始): ${rawBody}`);

      let data: ArkSubmitResponse;
      try {
        data = JSON.parse(rawBody) as ArkSubmitResponse;
      } catch {
        throw new Error(`火山引擎返回非 JSON: ${rawBody.slice(0, 200)}`);
      }

      if (!res.ok) {
        const errorMsg = data.error?.message || JSON.stringify(data.error) || `HTTP ${res.status}`;
        throw new Error(`火山引擎 API 错误: ${errorMsg}`);
      }

      const taskId = data.id;
      if (!taskId) {
        throw new Error("火山引擎返回中没有 task_id");
      }

      this.log(`任务已创建: ${taskId}, 状态: ${data.status}`);
      return { providerTaskId: taskId };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`火山引擎 API 超时 (${TIMEOUT_MS}ms)`);
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }

  /**
   * 查询任务状态
   */
  async query(providerTaskId: string, _modelId?: string): Promise<MediaQueryResult> {
    const apiKey = process.env.ARK_API_KEY;
    if (!apiKey) {
      return { status: "running" };
    }

    try {
      const res = await fetch(`${BASE_URL}/api/v3/contents/generations/tasks/${providerTaskId}`, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
      });

      if (!res.ok) {
        this.warn(`查询失败: ${res.status}`);
        return { status: "running" };
      }

      const data = await res.json() as ArkQueryResponse;

      // 打印完整查询结果（方便调试核对数据）
      this.log(`查询结果: ${JSON.stringify(data, null, 2)}`);

      // 状态映射
      const status = data.status;
      if (status === "succeeded") {
        const videoUrl = data.content?.video_url;
        if (!videoUrl) {
          return { status: "failed", error: "任务成功但未返回视频URL" };
        }
        return {
          status: "succeeded",
          outputUrls: [videoUrl],
          outputMeta: {
            width: undefined, // 官方 API 不直接返回宽高
            height: undefined,
            durationMs: data.duration ? data.duration * 1000 : undefined,
          },
          usage: data.usage?.completion_tokens
            ? {
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
              }
            : undefined,
        };
      }

      if (status === "failed" || status === "cancelled" || status === "expired") {
        return { status: "failed", error: data.error?.message || `任务${status}` };
      }

      // queued / running -> running
      return { status: "running" };
    } catch (error) {
      this.error(`查询异常: ${error}`);
      return { status: "running" };
    }
  }

  async cancel(_providerTaskId: string): Promise<void> {
    // 火山引擎官方 API 支持取消，但当前暂不实现
    this.warn("火山引擎官方 API 取消功能暂未实现");
  }
}

// 单例导出
export default new VolcVideoProvider();

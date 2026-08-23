/**
 * MediaProvider 抽象接口
 *
 * 所有 AI 媒体生成厂商（通义万相 / 可灵 / Mock 等）必须实现此接口。
 * 新增一个厂商 = 新建一个文件实现此接口 + 在 index.ts 注册表里加一条。
 *
 * 设计要点：
 *   - 任务分两阶段执行：submit（提交拿任务号） + query（轮询拿结果）
 *   - Provider 不直接接触 DB 和 OSS，只做"调第三方 API"这一件事
 *   - 由 job-poller 调用 query()，拿到第三方 URL 后再上传 OSS
 *   - isConfigured() 用于前端判断模型卡片是否置灰（未配置凭证时不可用）
 */

/** 任务种类：文生图 / 图生图 / 文生视频 / 图生视频 / 首尾帧生成视频 */
export type MediaKind = "t2i" | "i2i" | "t2v" | "i2v" | "flf2v";

/** 输入图（已存在的 OSS 资产 + 公网可访问的临时签名 URL） */
export interface MediaInputAsset {
  assetId: number;
  signedUrl: string;       // 给第三方 API 拉取用，需保证有效期 > 任务完成时长
  mime: string;
  width?: number | null;
  height?: number | null;
}

/** 提交生成任务的请求 */
export interface MediaJobRequest {
  jobId: number;
  userId: number;
  kind: MediaKind;
  modelId: string;
  prompt: string;
  negativePrompt?: string | null;

  /** I2I/I2V 输入图 或 FLF2V 首帧 */
  inputAsset?: MediaInputAsset | null;
  /** 仅 FLF2V 尾帧 */
  inputAssetEnd?: MediaInputAsset | null;

  /** 模型特定参数（尺寸/时长/分辨率/seed/steps...） */
  params: Record<string, unknown>;
}

/** Provider.submit 的返回 */
export interface MediaSubmitResult {
  /** 第三方任务 ID，用于后续 query */
  providerTaskId: string;
}

/** Provider.query 的返回 */
export interface MediaQueryResult {
  status: "running" | "succeeded" | "failed";
  /** succeeded 时返回，元素是第三方临时 URL（poller 会拉到 OSS） */
  outputUrls?: string[];
  /** 视频任务的封面图 URL（可选） */
  thumbnailUrl?: string;
  /** 媒体元数据（可选，poller 拿不到时会自己探测） */
  outputMeta?: {
    width?: number;
    height?: number;
    durationMs?: number;
  };
  /** 第三方实际消耗的 tokens（如火山引擎的 completion_tokens） */
  usage?: {
    completionTokens: number;
    totalTokens?: number;
  };
  /** failed 时的错误描述 */
  error?: string;
}

/** Provider 实现合约 */
export interface MediaProvider {
  /** 唯一标识：wanx / kling / mock */
  readonly name: string;

  /** 这家能做哪几种任务 */
  readonly supports: ReadonlyArray<MediaKind>;

  /** 凭证齐全否；不齐时前端置灰 */
  isConfigured(): boolean;

  /** 阶段 1：提交任务 */
  submit(req: MediaJobRequest): Promise<MediaSubmitResult>;

  /** 阶段 2：poller 轮询 */
  query(providerTaskId: string, modelId?: string): Promise<MediaQueryResult>;

  /** 可选：用户主动取消时调用（不支持则 no-op） */
  cancel?(providerTaskId: string): Promise<void>;
}

/** Provider 实现可继承此基类便于复用日志/错误格式 */
export abstract class BaseMediaProvider implements MediaProvider {
  abstract readonly name: string;
  abstract readonly supports: ReadonlyArray<MediaKind>;
  abstract isConfigured(): boolean;
  abstract submit(req: MediaJobRequest): Promise<MediaSubmitResult>;
  abstract query(providerTaskId: string, modelId?: string): Promise<MediaQueryResult>;

  protected log(msg: string, ...rest: unknown[]) {
    console.log(`[Media:${this.name}] ${msg}`, ...rest);
  }
  protected warn(msg: string, ...rest: unknown[]) {
    console.warn(`[Media:${this.name}] ${msg}`, ...rest);
  }
  protected error(msg: string, ...rest: unknown[]) {
    console.error(`[Media:${this.name}] ${msg}`, ...rest);
  }
}

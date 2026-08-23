/**
 * 媒体任务价格计算
 *
 * 价格单位：点（同 user_users.balance / billing_transactions.delta）
 *   - 1 元 = RECHARGE_POINTS_PER_YUAN 点（默认 100000）
 *
 * Seedance 2.0 视频任务：
 *   - 预估：按秒数 × 固定单价（元/秒）
 *     · 480p / 720p：0.9 元/秒
 *     · 1080p：1.2 元/秒
 *     · 4k：2.0 元/秒
 *   - 实际：按 API 返回的 tokens × 单价（元/百万 tokens）
 *     · 480p:  不含视频输入 46.00元/百万tokens，含视频输入 28.00元/百万tokens
 *     · 720p:  不含视频输入 51.00元/百万tokens，含视频输入 31.00元/百万tokens
 *     · 1080p: 不含视频输入 51.00元/百万tokens，含视频输入 31.00元/百万tokens
 *     · 4k:    不含视频输入 26.00元/百万tokens，含视频输入 16.00元/百万tokens
 *
 * 图片任务按"张"收费：
 *   - 文生图 / 图生图：每张 30 点 ≈ 0.3 元
 */

import type { MediaKind } from "./MediaProvider";

/** 充值比例：1 元 = N 点 */
function getPointsPerYuan(): number {
  return Number(process.env.RECHARGE_POINTS_PER_YUAN) || 100000;
}

/** 视频预估单价（元/秒），按分辨率 */
const VIDEO_ESTIMATE_PRICE_PER_SECOND: Record<string, number> = {
  "480p":  0.5,
  "720p":  1.0,
  "1080p": 2.5,
  "4k":    5.0,
};

/** Seedance 2.0 视频实际单价（元/百万 tokens），按分辨率 × 是否有视频输入 */
const VIDEO_PRICE_PER_1M_TOKENS: Record<string, { noInput: number; withInput: number }> = {
  "480p":  { noInput: 46.00, withInput: 28.00 },
  "720p":  { noInput: 51.00, withInput: 31.00 },
  "1080p": { noInput: 51.00, withInput: 31.00 },
  "4k":    { noInput: 26.00, withInput: 16.00 },
};

/** 图片单价（点/张） */
const IMAGE_PRICE_PER_UNIT = 30;

const VIDEO_KINDS: ReadonlyArray<MediaKind> = ["t2v", "i2v", "flf2v"];
const IMAGE_KINDS: ReadonlyArray<MediaKind> = ["t2i", "i2i"];

/**
 * 根据分辨率获取预估单价（元/秒）
 */
function getEstimatePricePerSecond(resolution: string): number {
  const res = resolution.toLowerCase();
  let price = VIDEO_ESTIMATE_PRICE_PER_SECOND[res];
  if (price == null) {
    if (res.includes("1080")) price = VIDEO_ESTIMATE_PRICE_PER_SECOND["1080p"];
    else if (res.includes("480")) price = VIDEO_ESTIMATE_PRICE_PER_SECOND["480p"];
    else if (res.includes("4k")) price = VIDEO_ESTIMATE_PRICE_PER_SECOND["4k"];
    else price = VIDEO_ESTIMATE_PRICE_PER_SECOND["720p"];
  }
  return price;
}

/**
 * 根据分辨率获取实际单价配置（元/百万tokens）
 */
function getVideoPrice(resolution: string): { noInput: number; withInput: number } {
  const res = resolution.toLowerCase();
  let price = VIDEO_PRICE_PER_1M_TOKENS[res];
  if (!price) {
    if (res.includes("1080")) price = VIDEO_PRICE_PER_1M_TOKENS["1080p"];
    else if (res.includes("480")) price = VIDEO_PRICE_PER_1M_TOKENS["480p"];
    else if (res.includes("4k")) price = VIDEO_PRICE_PER_1M_TOKENS["4k"];
    else price = VIDEO_PRICE_PER_1M_TOKENS["720p"];
  }
  return price;
}

/**
 * 计算视频任务实际价格（根据 API 返回的 token 消耗）
 *
 * @param resolution 分辨率
 * @param hasVideoInput 是否有视频输入（不是图片参考）
 * @param tokens 实际消耗的 completion_tokens
 * @returns 价格（元 和 点）
 */
export function calculateVideoPrice(
  resolution: string,
  hasVideoInput: boolean,
  tokens: number
): { yuan: number; points: number; breakdown: string } {
  const pointsPerYuan = getPointsPerYuan();
  const price = getVideoPrice(resolution);
  const yuanPer1M = hasVideoInput ? price.withInput : price.noInput;

  // 费用 = (tokens / 1_000_000) * 单价
  const yuan = (tokens / 1_000_000) * yuanPer1M;
  const points = Math.ceil(yuan * pointsPerYuan);

  const breakdown = `${tokens} tokens × ${yuanPer1M}元/百万tokens = ${yuan.toFixed(4)}元（${resolution}${hasVideoInput ? "，含视频输入" : "，纯文本/图片"}）`;

  return { yuan, points, breakdown };
}

/**
 * 估算一个生成任务的预扣点数
 *
 * 预扣策略：
 *   - 视频任务：按秒数 × 分辨率固定单价（元/秒）
 *   - 图片任务：按张数
 *
 * @param _modelId 模型 id（保留参数，当前未使用）
 * @param kind 任务种类
 * @param params 模型参数（用于读取 resolution / duration 等量值）
 */
export async function estimatePoints(
  _modelId: string,
  kind: MediaKind,
  params: Record<string, unknown>
): Promise<{ points: number; breakdown: string }> {
  const pointsPerYuan = getPointsPerYuan();

  // 1. 视频类任务：按秒数 × 固定单价（预扣）
  if (VIDEO_KINDS.includes(kind)) {
    const resolution = String(params.resolution || "720p").toLowerCase();
    const duration = Number(params.duration) || 5;

    const yuanPerSecond = getEstimatePricePerSecond(resolution);
    const estimatedYuan = duration * yuanPerSecond;
    const points = Math.ceil(estimatedYuan * pointsPerYuan);

    const breakdown = `预扣：${duration}秒 × ${yuanPerSecond}元/秒（${resolution}）= ${estimatedYuan.toFixed(2)}元`;

    return { points, breakdown };
  }

  // 2. 图片类任务：按张数
  if (IMAGE_KINDS.includes(kind)) {
    const n = Math.max(1, Math.min(4, Number(params.n) || 1));
    const points = IMAGE_PRICE_PER_UNIT * n;
    const breakdown = `${IMAGE_PRICE_PER_UNIT} 点/张 × ${n}张 = ${points} 点`;
    return { points, breakdown };
  }

  // 兜底
  return { points: 100, breakdown: "未知类型，默认 100 点" };
}

/**
 * 任务成功后计算实际价格（根据 API 返回的 token 数）
 * 用于 poller 确认实际扣费
 *
 * @param resolution 分辨率
 * @param hasVideoInput 是否有视频输入
 * @param tokens 实际消耗的 completion_tokens（来自 API 返回的 usage）
 */
export function getActualPrice(
  resolution: string,
  hasVideoInput: boolean,
  tokens: number = 0
): { yuan: number; points: number; breakdown: string } {
  return calculateVideoPrice(resolution, hasVideoInput, tokens);
}

/**
 * 默认模型映射：根据 kind 推断默认 provider/model
 * （v1 用，未来由前端传具体 modelId）
 */
export function getDefaultModel(kind: MediaKind): { modelId: string; provider: string } {
  switch (kind) {
    case "t2i":
    case "i2i":
      return { modelId: "wan2.7-image", provider: "alibaba" };
    case "t2v":
    case "i2v":
    case "flf2v":
      return { modelId: "wan2.7-t2v-2026-04-25", provider: "alibaba-video" };
  }
}

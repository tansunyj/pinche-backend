/**
 * Cloudflare Turnstile 后端校验工具
 *
 * 环境变量：
 *   TURNSTILE_SECRET_KEY  - Cloudflare 提供的 secret key（复制自老网站后端配置）
 *   TURNSTILE_SITE_KEY    - 前端渲染用的 site key（通过 /api/status 下发）
 *
 * 行为（与老 website_backend 一致）：
 *   - 未配置 TURNSTILE_SECRET_KEY 时直接放行（开发模式友好）
 *   - 配置后强制校验，未通过返回 success=false + error
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function isTurnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

export interface TurnstileVerifyResult {
  success: boolean;
  error?: string;
  raw?: any;
}

/** 从请求中提取客户端 IP（优先 x-forwarded-for 首段） */
export function clientIp(req: import("express").Request): string | undefined {
  const xff = req.headers["x-forwarded-for"];
  const first =
    typeof xff === "string" ? xff.split(",")[0]?.trim() : Array.isArray(xff) ? xff[0] : undefined;
  return first || req.ip || undefined;
}

export async function verifyTurnstile(
  token: string | undefined | null,
  remoteip?: string
): Promise<TurnstileVerifyResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  // 未配置 secret 时直接放行
  if (!secret) {
    return { success: true };
  }

  if (!token || typeof token !== "string") {
    return { success: false, error: "人机验证未通过，请刷新后重试" };
  }

  try {
    const params = new URLSearchParams();
    params.append("secret", secret);
    params.append("response", token);
    if (remoteip) params.append("remoteip", remoteip);

    const resp = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = (await resp.json()) as { success?: boolean; "error-codes"?: string[] };

    if (data && data.success) {
      return { success: true, raw: data };
    }
    console.warn("[Turnstile] 校验失败:", data && data["error-codes"]);
    return { success: false, error: "人机验证未通过，请重试", raw: data };
  } catch (e: any) {
    console.error("[Turnstile] 校验请求异常:", e?.message || e);
    return { success: false, error: "人机验证服务暂不可用，请稍后再试" };
  }
}

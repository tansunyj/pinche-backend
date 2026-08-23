/**
 * 第三方扫码登录（微信开放平台 / 支付宝开放平台）
 *
 * 桌面端"扫码登录"统一流程：
 *
 *   1. 前端弹窗里选了"微信"/"支付宝"
 *        → POST /api/oauth/:provider/init
 *        ← { state, qrCodeContent }   前端用 qrcode 库渲染二维码
 *
 *   2. 前端开始轮询：GET /api/oauth/poll?state=xxx 每 2 秒一次
 *
 *   3. 用户扫码 + 在手机端确认授权
 *        → 第三方服务器重定向到 GET /api/oauth/:provider/callback?code=...&state=...
 *        backend: 校验 state → exchangeCode 拿 user → find/create user → issue session
 *                → 把 {accessToken, user} 暂存到 Redis 的 oauth:result:{state}（TTL 5min）
 *                → 返回一个简单 HTML 页面 "登录成功，请回到原窗口"
 *
 *   4. 前端轮询命中 → 拿到 token + user → 关闭弹窗 + setUser
 *
 *   DRY-RUN：第三方未配置时返回 mock provider_id，便于本地联调。
 *
 *   额外提供：GET /api/oauth/:provider/dev-complete?state=xxx
 *           本地无法真正接收第三方回调时，前端按钮点一下直接走完闭环。
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import redis from "../utils/redis";
import UserService, { getPublicUser } from "../services/UserService";
import { issueAuthSession } from "../utils/auth-session-mysql";
import { getOAuthProvider, listOAuthProviders } from "../services/oauth";

const router = Router();

const STATE_TTL_SECONDS = 5 * 60; // 二维码 5 分钟
const RESULT_TTL_SECONDS = 5 * 60; // 登录结果在 Redis 留 5 分钟供轮询

function stateKey(s: string) {
  return `oauth:state:${s}`;
}
function resultKey(s: string) {
  return `oauth:result:${s}`;
}

// ============ 可用通道（前端按需渲染按钮）============
router.get("/providers", (_req, res) => {
  res.json({ providers: listOAuthProviders() });
});

// ============ 申请二维码 ============
router.post("/:provider/init", async (req: Request, res: Response) => {
  const providerName = req.params.provider;
  const provider = getOAuthProvider(providerName);
  if (!provider) {
    res.status(404).json({ error: `未知的 OAuth 通道: ${providerName}` });
    return;
  }

  try {
    const state = crypto.randomBytes(16).toString("hex");
    await redis.setex(
      stateKey(state),
      STATE_TTL_SECONDS,
      JSON.stringify({ provider: providerName, status: "pending", createdAt: Date.now() })
    );
    const { qrCodeContent, authPageUrl } = provider.buildAuthUrl(state);

    res.json({
      state,
      provider: providerName,
      qrCodeContent,
      authPageUrl,
      expiresIn: STATE_TTL_SECONDS,
      dryRun: provider.isDryRun(),
    });
  } catch (err: any) {
    console.error(`[oauth] init ${providerName} error:`, err);
    res.status(500).json({ error: err?.message || "申请扫码失败" });
  }
});

// ============ 轮询登录状态（前端调）============
router.get("/poll", async (req: Request, res: Response) => {
  const state = String(req.query.state || "");
  if (!state) {
    res.status(400).json({ error: "缺少 state 参数" });
    return;
  }

  // 1. 看是否已有结果
  const resultRaw = await redis.get(resultKey(state));
  if (resultRaw) {
    // 一次性消费：取出立刻删
    await redis.del(resultKey(state), stateKey(state));
    try {
      const result = JSON.parse(resultRaw);
      res.json({ status: "completed", ...result });
      return;
    } catch {
      res.status(500).json({ error: "登录结果损坏，请重新扫码" });
      return;
    }
  }

  // 2. 看 state 是否还活着
  const stateRaw = await redis.get(stateKey(state));
  if (!stateRaw) {
    res.json({ status: "expired" });
    return;
  }
  res.json({ status: "pending" });
});

// ============ 第三方回调（用户扫码确认后跳转到这里）============
// 兼容 dev-complete（同函数 + 直接传 mock code）
async function handleCallback(req: Request, res: Response) {
  const providerName = req.params.provider;
  const provider = getOAuthProvider(providerName);
  if (!provider) {
    res.status(404).send("provider not found");
    return;
  }

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");

  console.log(`\n========== [OAuth Callback] ${providerName} ==========`);
  console.log(`[OAuth] state=${state} code=${code?.slice(0, 16)}...`);

  if (!state || !code) {
    res.status(400).send("missing code or state");
    return;
  }

  const stateRaw = await redis.get(stateKey(state));
  if (!stateRaw) {
    res.status(400).send("state 已过期或不存在，请重新扫码");
    return;
  }

  try {
    const info = await provider.exchangeCode(code);
    console.log(`[OAuth] 第三方 user info: providerId=${info.providerId} name=${info.nickname}`);

    // 找/建用户
    let user = await UserService.findByProvider(providerName as any, info.providerId);
    let isNewUser = false;
    if (!user) {
      const { userId } = await UserService.createOAuthUser({
        provider: providerName as any,
        providerId: info.providerId,
        name: info.nickname ?? null,
        avatar: info.avatar ?? null,
      });
      user = await UserService.findById(userId);
      isNewUser = true;
    }
    if (!user) throw new Error("用户创建失败");

    // 颁发会话（access cookie + refresh cookie 都会写到响应里；但浏览器是直接跳转到这里的，cookie 会落到根域名）
    const { accessToken } = await issueAuthSession(user, res);

    // 把结果存 Redis 给前端轮询使用
    await redis.setex(
      resultKey(state),
      RESULT_TTL_SECONDS,
      JSON.stringify({
        token: accessToken,
        user: getPublicUser(user),
        isNewUser,
      })
    );
    // 标记 state 已完成
    await redis.setex(
      stateKey(state),
      STATE_TTL_SECONDS,
      JSON.stringify({ provider: providerName, status: "completed" })
    );

    // 简单的 HTML 提示，告知用户回到原窗口
    res.type("html").send(`
      <!doctype html><html><head><meta charset="utf-8"><title>登录成功</title></head>
      <body style="font-family:-apple-system,Segoe UI,sans-serif;text-align:center;padding-top:80px;color:#1f2937;">
        <h2 style="color:#10b981;">✓ 登录成功</h2>
        <p>请返回原页面，窗口将在 3 秒后自动关闭。</p>
        <script>setTimeout(() => window.close(), 3000);</script>
      </body></html>
    `);
  } catch (err: any) {
    console.error(`[OAuth] ${providerName} 回调处理失败:`, err);
    await redis.setex(
      resultKey(state),
      RESULT_TTL_SECONDS,
      JSON.stringify({ error: err?.message || "授权失败" })
    );
    res.status(500).type("html").send(`
      <!doctype html><html><body style="text-align:center;padding-top:80px;font-family:-apple-system,sans-serif;color:#dc2626;">
        <h2>授权失败</h2><p>${escapeHtml(err?.message || "未知错误")}</p>
      </body></html>
    `);
  }
}

router.get("/:provider/callback", handleCallback);

// ============ Dev 工具：本地无法触发真实回调时，前端按钮直接走闭环 ============
router.post("/:provider/dev-complete", async (req: Request, res: Response) => {
  const provider = getOAuthProvider(req.params.provider);
  if (!provider || !provider.isDryRun()) {
    res.status(400).json({ error: "dev-complete 仅在 dry-run 模式下可用" });
    return;
  }
  // 注入 query 让 handleCallback 复用
  req.query.code = `mock_code_${Date.now()}`;
  req.query.state = String(req.body?.state || req.query.state || "");
  return handleCallback(req, res);
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

export default router;

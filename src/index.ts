/**
 * Token 拼车平台 - 统一后端入口
 *
 * 用户端 + 管理端融合为一个进程，路由按前缀分流：
 *   /api/auth/*    用户认证（手机号+验证码）
 *   /api/user/*    用户端（需用户 JWT）
 *   /api/rides/*   车次（公开读 + 上车）
 *   /api/admin/*   管理端（需管理员 JWT）
 *   /api/payment/* 支付宝回调
 */

// 必须在所有其它 import 之前：按 NODE_ENV 加载对应的 .env.{development,production}
import "./config/env";
import logger from "./utils/logger";

logger.startup("========================================");
logger.startup("应用启动中...");
logger.startup("NODE_ENV:", process.env.NODE_ENV);
logger.startup("LOG_LEVEL:", logger.getLevel());
logger.startup("PORT:", process.env.PORT || 14001);

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// ---- 用户端路由 ----
import authRoutes from "./routes/auth";
import userProfileRoutes from "./routes/user/profile";
import userBalanceRoutes from "./routes/user/balance";
import userKeysRoutes from "./routes/user/keys";
import userLogsRoutes from "./routes/user/logs";
import userStatsRoutes from "./routes/user/stats";

// ---- 拼车业务路由（任务6）----
import ridesRoutes from "./routes/rides";
import userRidesRoutes from "./routes/user/rides";
import userDiscountsRoutes from "./routes/user/discounts";
import userRechargeRoutes from "./routes/recharge";

// ---- 管理端路由 ----
import adminAuthRoutes from "./routes/admin/auth";
import adminUsersRoutes from "./routes/admin/users";
import adminChannelsRoutes from "./routes/admin/channels";
import adminChannelModelsRoutes from "./routes/admin/channel-models";
import adminPaymentsRoutes from "./routes/admin/payments";
import adminStatsRoutes from "./routes/admin/stats";
import adminTiersRoutes from "./routes/admin/tiers";
import adminRidesRoutes from "./routes/admin/rides";
import adminLogsRoutes from "./routes/admin/logs";
import adminTokensRoutes from "./routes/admin/tokens";
import adminModelsRoutes from "./routes/admin/models";
import adminModelConfigsRoutes from "./routes/admin/model-configs";

// ---- 系统接口 ----
import statusRoutes from "./routes/system/status";
import noticeRoutes from "./routes/system/notice";
import homePageContentRoutes from "./routes/system/home-page-content";
import pricingRoutes from "./routes/system/pricing";
import perfMetricsRoutes from "./routes/system/perf-metrics";

import { checkConnections } from "./config/db";
import { initCronJobs } from "./cron";

const app = express();
const PORT = Number(process.env.PORT) || 14001;

// CORS
const corsOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
app.set("trust proxy", 1);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: "请求过于频繁，请稍后再试" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", limiter);

app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// 统一移除尾斜杠
app.use((req, res, next) => {
  if (req.path.endsWith("/") && req.path.length > 1) {
    req.url = req.url.slice(0, -1);
  }
  next();
});

// ==================== 路由挂载 ====================

// 用户认证
app.use("/api/auth", authRoutes);

// 用户端
app.use("/api/user/profile", userProfileRoutes);
app.use("/api/user/balance", userBalanceRoutes);
app.use("/api/user/keys", userKeysRoutes);
app.use("/api/user/logs", userLogsRoutes);
app.use("/api/user/stats", userStatsRoutes);

// 拼车业务（用户端）
app.use("/api/user/rides", userRidesRoutes);
app.use("/api/user/discounts", userDiscountsRoutes);

// 充值（支付宝回调在 recharge/callback，勿重复挂载）
app.use("/api/recharge", userRechargeRoutes);

// 车次（公开）
app.use("/api/rides", ridesRoutes);

// 管理端
app.use("/api/admin/auth", adminAuthRoutes);
app.use("/api/admin/users", adminUsersRoutes);
app.use("/api/admin/channels", adminChannelsRoutes);
app.use("/api/admin/channels", adminChannelModelsRoutes);
app.use("/api/admin/payments", adminPaymentsRoutes);
app.use("/api/admin/stats", adminStatsRoutes);
app.use("/api/admin/tiers", adminTiersRoutes);
app.use("/api/admin/rides", adminRidesRoutes);
app.use("/api/admin/logs", adminLogsRoutes);
app.use("/api/admin/tokens", adminTokensRoutes);
app.use("/api/admin/models", adminModelsRoutes);
app.use("/api/admin/model-configs", adminModelConfigsRoutes);

// 系统状态（前端 newapi 页面 / useSidebarConfig / useTopNavLinks 消费）
app.use("/api/status", statusRoutes);

// 模型广场（前端 features/pricing 消费）
app.use("/api/pricing", pricingRoutes);

// 性能指标空 stub（模型广场详情抽屉 Overview 消费）
app.use("/api/perf-metrics", perfMetricsRoutes);

// 平台公告 + 自定义首页内容（前端 useNotifications / useHomePageContent 消费）
app.use("/api/notice", noticeRoutes);
app.use("/api/home_page_content", homePageContentRoutes);

// ==================== 系统接口 ====================

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    name: "carpool-server",
    version: "1.0.0",
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: { message: "接口不存在", path: req.path } });
});

// 全局错误处理
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("未捕获的错误:", err);
  res.status(500).json({
    error: "服务器内部错误",
    details: process.env.NODE_ENV === "development" ? err?.message : undefined,
  });
});

async function main() {
  try {
    await checkConnections();
    console.log(`✓ MySQL 连接成功（网关库=${process.env.GATEWAY_DB || "silievo"} / 拼车库=${process.env.CARPOOL_DB || "pt_carpool"}）`);

    const HOST = process.env.HOST || "127.0.0.1";
    app.listen(PORT, HOST, () => {
      console.log(`
  ════════════════════════════════════════════════════════════
    🚌 Token 拼车平台 - 统一后端
    📍 Server:  http://${HOST}:${PORT}
    🧑 用户端:  http://${HOST}:${PORT}/api/user
    🚏 车次:    http://${HOST}:${PORT}/api/rides
    🔐 管理端:  http://${HOST}:${PORT}/api/admin
    💰 Health:  http://${HOST}:${PORT}/api/health
  ════════════════════════════════════════════════════════════
      `);
    });

    // 启动定时任务（活跃度回收 / 到期置 EXPIRED / 充值对账）
    initCronJobs();
    console.log("[Cron] 定时任务已启动");
  } catch (error) {
    console.error("启动失败:", error);
    process.exit(1);
  }
}

main().catch(console.error);

process.on("uncaughtException", (err) => console.error("[Uncaught Exception]", err));
process.on("unhandledRejection", (reason) => console.error("[Unhandled Rejection]", reason));

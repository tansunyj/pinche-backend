// 必须在所有其它 import 之前：按 NODE_ENV 加载对应的 .env.{development,production}
import "./utils/env";
import logger from "./utils/logger";

// 启动日志
logger.startup("========================================");
logger.startup("应用启动中...");
logger.startup("NODE_ENV:", process.env.NODE_ENV);
logger.startup("LOG_LEVEL:", logger.getLevel());
logger.startup("PORT:", process.env.PORT || 13001);

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth";
import tokenRoutes from "./routes/tokens";
import postRoutes from "./routes/posts";
import taskRoutes from "./routes/tasks";
import skillRoutes from "./routes/skills";
import modelRoutes from "./routes/models";
import marketplaceRoutes from "./routes/marketplace";
import adminModelRoutes from "./routes/admin-models";
import adminOrderRoutes from "./routes/admin-orders";
import orderRoutes from "./routes/orders";
import agentRoutes from "./routes/agents";
import smsRoutes from "./routes/sms";
import paymentRoutes from "./routes/payments";
import oauthRoutes from "./routes/oauth";
import { checkMysqlConnection } from "./db/mysql";
import pool from "./db/mysql";
import SiliEvoAgent from "./agent";
import feedbackRoutes from "./routes/feedback";
import comicWorkflowRoutes from "./routes/comic-workflow";
import adminAuditRoutes from "./routes/admin-audit";
import mediaRoutes from "./routes/media";
import volcRoutes from "./routes/media-volc";
import usageRoutes from "./routes/usage";
import dashboardRoutes from "./routes/dashboard";
// import promotionRoutes from "./marketing/routes/aliyun-free-week";
import { attachAuditAutoFlush } from "./utils/audit";
import { openApiSpec } from "./openapi";
import OssService from "./services/storage/OssService";
import { startMediaPoller } from "./services/media/job-poller";
import referralRoutes from "./routes/referral";
import adminReferralRoutes from "./routes/admin-referral";
import promotionsRoutes from "./routes/promotions";
import modelDiscountsRoutes from "./routes/model-discounts";
import userPackageRoutes from "./routes/user-package";
import packagesRoutes from "./routes/packages";
import SchedulerService from "./services/SchedulerService";

const app = express();
const PORT = process.env.PORT || 13001;
const corsOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3002",
  "http://127.0.0.1:3002",
  "http://localhost:13000",
  "http://127.0.0.1:13000",
  "http://silievo.com",
  "https://silievo.com",
  "http://www.silievo.com",
  "https://www.silievo.com",
  process.env.ADMIN_WEB_URL,
].filter(Boolean) as string[];

// 安全中间件
app.use(helmet());
app.set("trust proxy", 1);

// 请求频率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 1000, // 限制每个 IP 15 分钟内最多 1000 次请求
  message: { error: "请求过于频繁，请稍后再试" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", limiter);

app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));
app.use(express.json());

// 处理尾斜杠：统一移除，使 /api/path 和 /api/path/ 都能匹配
app.use((req, res, next) => {
  if (req.path.endsWith('/') && req.path.length > 1) {
    req.url = req.url.slice(0, -1);
  }
  next();
});

app.get("/skill.md", (_req, res) => {
  res.redirect("/api/agents/skill.md");
});

app.get("/heartbeat.md", (_req, res) => {
  res.redirect("/api/agents/heartbeat.md");
});

// 业务路由：用户写操作自动审计（落 user_audit_log，category=user）
const userAuditFlush = attachAuditAutoFlush({ category: "user" });

app.use("/api/auth", userAuditFlush, authRoutes);
app.use("/api/tokens", userAuditFlush, tokenRoutes);
app.use("/api/posts", userAuditFlush, postRoutes);
app.use("/api/tasks", userAuditFlush, taskRoutes);
app.use("/api/skills", userAuditFlush, skillRoutes);
app.use("/api/models", modelRoutes);
app.use("/api/marketplace", marketplaceRoutes);

// 管理员后台：写操作自动审计（落 user_audit_log，category=admin）
const adminAuditFlush = attachAuditAutoFlush({ category: "admin" });
app.use("/api/admin", adminAuditFlush);
app.use("/api/admin/models", adminModelRoutes);
app.use("/api/admin/orders", adminOrderRoutes);
app.use("/api/admin/audit-logs", adminAuditRoutes);
app.use("/api/admin/referral", adminReferralRoutes);

app.use("/api/orders", userAuditFlush, orderRoutes);
app.use("/api/payments", userAuditFlush, paymentRoutes);
app.use("/api/oauth", oauthRoutes); // 不加 audit：未登录状态下发起
app.use("/api/agents", agentRoutes);
app.use("/api/sms", userAuditFlush, smsRoutes);
app.use("/api/feedback", userAuditFlush, feedbackRoutes);
app.use("/api/comic-workflow", userAuditFlush, comicWorkflowRoutes);
app.use("/api/media", userAuditFlush, mediaRoutes);
app.use("/api/media", userAuditFlush, volcRoutes);
app.use("/api/usage", userAuditFlush, usageRoutes);
app.use("/api/dashboard", userAuditFlush, dashboardRoutes);
// app.use("/api/promotion", userAuditFlush, promotionRoutes);
app.use("/api/referral", userAuditFlush, referralRoutes);
app.use("/api/promotions", promotionsRoutes);
app.use("/api/model-discounts", userAuditFlush, modelDiscountsRoutes);
app.use("/api/user/package", userAuditFlush, userPackageRoutes);
app.use("/api/packages", packagesRoutes);

// dry-run OSS：把 ./tmp/oss-mock/ 通过 /mock-oss/* 暴露给前端
// 仅在 STORAGE_DRY_RUN 启用时生效；生产 OSS 走真签名 URL
app.get(/^\/mock-oss\/(.+)$/, async (req, res) => {
  try {
    const ossKey = decodeURIComponent(req.params[0]);
    const obj = await OssService.readMockObject(ossKey);
    if (!obj) {
      res.status(404).send("mock object not found");
      return;
    }
    // 设置 CORS 头，允许前端跨域访问
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    // 关键：允许跨域图片加载，覆盖 helmet 的 CORP 头
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.removeHeader("Cross-Origin-Opener-Policy");
    res.setHeader("Content-Type", obj.mime);
    res.setHeader("Content-Length", String(obj.size));
    res.setHeader("Cache-Control", "private, max-age=3600");
    obj.stream.pipe(res);
  } catch (e: any) {
    res.status(500).send(`mock-oss error: ${e?.message || e}`);
  }
});

// mock-oss 的 OPTIONS 预检请求
app.options(/^\/mock-oss\/(.+)$/, (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.status(204).send();
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/openapi.json", (_req, res) => {
  res.json(openApiSpec);
});

app.get("/api/stats", async (_req, res) => {
  try {
    // 使用 MySQL 查询统计数据（替代 Prisma）
    const [[userRow], [postRow], [taskRow], [skillRow], [modelRow], [agentRow], [capsuleRow]] = await Promise.all([
      pool.execute("SELECT COUNT(*) as cnt FROM user_users") as any,
      pool.execute("SELECT COUNT(*) as cnt FROM posts") as any,
      pool.execute("SELECT COUNT(*) as cnt FROM tasks") as any,
      pool.execute("SELECT COUNT(*) as cnt FROM skills") as any,
      pool.execute("SELECT COUNT(*) as cnt FROM models") as any,
      pool.execute("SELECT COUNT(*) as cnt FROM agents") as any,
      pool.execute("SELECT COUNT(*) as cnt FROM capsules") as any,
    ]);

    const users = userRow?.[0]?.cnt || 0;
    const posts = postRow?.[0]?.cnt || 0;
    const tasks = taskRow?.[0]?.cnt || 0;
    const skills = skillRow?.[0]?.cnt || 0;
    const models = modelRow?.[0]?.cnt || 0;
    const agents = agentRow?.[0]?.cnt || 0;
    const capsules = capsuleRow?.[0]?.cnt || 0;

    res.json({
      onlineAgents: agents,
      totalTasks: tasks,
      skillModules: skills,
      modelAPIs: models,
      capsules: capsules,
      agents,
      tasks,
      skills,
      models,
      users,
      posts,
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ error: "获取统计失败" });
  }
});

// 全局错误处理中间件
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("未捕获的错误:", err);
  res.status(500).json({ error: "服务器内部错误", details: process.env.NODE_ENV === "development" ? err.message : undefined });
});

async function main() {
  try {
    // MySQL 是核心数据源
    await checkMysqlConnection();
    console.log(
      `✓ MySQL 连接成功 (${process.env.MYSQL_HOST || "localhost"}:${
        process.env.MYSQL_PORT || 3306
      }/${process.env.MYSQL_DATABASE || "silievo"})`
    );

    // 支付配置检查（调试用）
    console.log(`[Payment] ALIPAY_APP_ID=${process.env.ALIPAY_APP_ID ? "已配置" : "未配置"}`);
    console.log(`[Payment] ALIPAY_APP_PRIVATE_KEY=${process.env.ALIPAY_APP_PRIVATE_KEY ? "已配置" : "未配置"}`);
    console.log(`[Payment] ALIPAY_PUBLIC_KEY=${process.env.ALIPAY_PUBLIC_KEY ? "已配置" : "未配置"}`);
    console.log(`[Payment] PAYMENT_DRY_RUN=${process.env.PAYMENT_DRY_RUN}`);

    const HOST = process.env.HOST || "127.0.0.1";
    const PORT_NUM = Number(PORT) || 13001;
    app.listen(PORT_NUM, HOST, () => {
      console.log(`✓ 服务器运行在 http://${HOST}:${PORT_NUM}`);
      console.log(`✓ API 地址: http://${HOST}:${PORT_NUM}/api`);
      if (HOST === "127.0.0.1") {
        console.log(`✓ 安全模式: 仅监听本地地址，外网无法直接访问`);
      }
    });

    // 启动自主维护 Agent（暂时禁用：依赖 posts/capsule/agent_approval 表尚未创建）
    // const autoAgent = new SiliEvoAgent();
    // autoAgent.start();

    // 启动多媒体任务 poller（5s 扫一次 running 任务）
    console.log(`[Startup] MEDIA_DRY_RUN=${process.env.MEDIA_DRY_RUN || "false (默认)"}`);
    console.log(`[Startup] 启动 MediaPoller，扫描间隔 ${process.env.MEDIA_POLL_INTERVAL_MS || 5000}ms`);
    startMediaPoller();

    // 启动定时任务（月度结算）
    SchedulerService.start();
    console.log(`[Startup] 定时任务已启动（月度结算）`);
  } catch (error) {
    console.error("启动失败:", error);
    process.exit(1);
  }
}

main().catch(console.error);

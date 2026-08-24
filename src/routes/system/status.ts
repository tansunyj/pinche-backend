/**
 * 系统状态（挂载 /api/status）
 *
 * 供前端 newapi 风格页面消费，响应结构为 { success, data: { ... } }：
 *   - use-status / use-sidebar-config：读 data.SidebarModulesAdmin（字符串化 JSON，侧边栏模块门控）
 *   - use-top-nav-links / nav-modules：读 data.HeaderNavModules + data.docs_link（顶部导航门控）
 *   - use-system-config：读 data.system_name / logo / footer_html / demo_site_enabled /
 *     display_token_stat_enabled / 货币相关字段（display_in_currency / quota_display_type /
 *     quota_per_unit / usd_exchange_rate / custom_currency_symbol / custom_currency_exchange_rate）
 *
 * 拼车后端没有系统配置表，这里返回与前端默认值对齐的静态配置（可用环境变量覆盖），
 * 不新建表、不依赖网关库。
 */

import { Router, Request, Response } from "express";

const router = Router();

/** 侧边栏模块门控：与前端 DEFAULT_SIDEBAR_MODULES 形状一致的全启用配置 */
const SIDEBAR_MODULES_ADMIN = {
  chat: { enabled: true, playground: true, chat: true },
  console: {
    enabled: true,
    detail: true,
    token: true,
    log: true,
    midjourney: true,
    task: true,
  },
  personal: { enabled: true, topup: true, personal: true },
  admin: {
    enabled: true,
    channel: true,
    models: true,
    redemption: true,
    user: true,
    setting: true,
    subscription: true,
  },
};

/** 顶部导航门控：与前端 DEFAULT_HEADER_NAV_MODULES 一致
 *  拼车平台暂不提供 LLM 排行榜 / 关于页，入口隐藏；
 *  文档菜单指向站内 /docs 接入文档页（如配置 docs_link 则优先外部链接） */
const HEADER_NAV_MODULES = {
  home: true,
  console: true,
  pricing: { enabled: true, requireAuth: false },
  rankings: { enabled: false, requireAuth: false },
  docs: true,
  about: false,
};

// GET /api/status
router.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "ok",
    data: {
      version: "1.0.0",
      system_name: process.env.SYSTEM_NAME || "Token 拼车平台",
      logo: process.env.SYSTEM_LOGO || "",
      // 网关地址:供前端 API 接入文档 / CC Switch / 聊天预设解析 Base URL。
      // 生产环境用 SERVER_ADDRESS 环境变量配置(如 https://api.example.com);留空则前端回退本地默认。
      server_address: process.env.SERVER_ADDRESS || "",
      footer_html: "",
      demo_site_enabled: false,
      display_token_stat_enabled: true,
      // 配额展示：拼车场景以「点数」为单位展示，不做货币换算
      display_in_currency: false,
      quota_display_type: "TOKENS",
      quota_per_unit: 500000,
      usd_exchange_rate: 7.0,
      custom_currency_symbol: "¥",
      custom_currency_exchange_rate: 1,
      // 注册/登录形态：用户端为手机号 + 短信验证码
      register_enabled: true,
      password_login_enabled: false,
      password_register_enabled: false,
      email_verification: false,
      oauth_register_enabled: false,
      turnstile_check: !!process.env.TURNSTILE_SITE_KEY,
      turnstile_site_key: process.env.TURNSTILE_SITE_KEY || "",
      self_use_mode_enabled: false,
      SidebarModulesAdmin: JSON.stringify(SIDEBAR_MODULES_ADMIN),
      HeaderNavModules: JSON.stringify(HEADER_NAV_MODULES),
      docs_link: "",
    },
  });
});

export default router;

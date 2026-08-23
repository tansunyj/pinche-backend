/**
 * 自定义首页内容（挂载 /api/home_page_content）
 *
 * 供前端 useHomePageContent 消费，响应结构 { success, message, data }，data 为 Markdown/HTML 内容或 iframe URL。
 * 拼车后端暂无首页配置，返回空内容（前端渲染默认首页），不新建表。
 */

import { Router, Request, Response } from "express";

const router = Router();

// GET /api/home_page_content
router.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "ok",
    data: process.env.SYSTEM_HOME_PAGE_CONTENT || "",
  });
});

export default router;

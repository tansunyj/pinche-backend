/**
 * 平台公告（挂载 /api/notice）
 *
 * 供前端 useNotifications 消费，响应结构 { success, message, data }，data 为公告文本（可含 Markdown）。
 * 拼车后端暂无公告表，返回空公告（可用环境变量 SYSTEM_NOTICE 覆盖），不新建表。
 */

import { Router, Request, Response } from "express";

const router = Router();

// GET /api/notice
router.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "ok",
    data: process.env.SYSTEM_NOTICE || "",
  });
});

export default router;

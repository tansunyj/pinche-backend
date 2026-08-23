/**
 * 消费日志（挂载 /api/user/logs）
 * 直连网关库 proxy_logs 只读查询当前用户消费记录（分页）。
 */

import { Router, Request, Response } from "express";
import { gatewayPool } from "../../config/db";
import { userAuth } from "../../middlewares/userAuth";

const router = Router();
router.use(userAuth);

/** 1 元 = 100000 额度（与网关计费口径一致） */
const QUOTA_PER_YUAN = 100000;

// proxy_logs 真实列：id, user_id, token_id, channel_id, request_id, channel_name, model,
// prompt_tokens, completion_tokens, quota_consumed, latency_ms, status, error_msg,
// is_thinking, price_markup, created_at, aborted, package_id, package_name,
// billing_detail（计费多行明细：tokens 消耗 + 各维度费用，\n 拼接）
// 对外映射：status←status，cost_points←quota_consumed，cost_amount←quota_consumed/QUOTA_PER_YUAN，
//          discount←price_markup，prompt_tokens/completion_tokens/billing_detail 原样透传
const LOG_SELECT = `
  SELECT id, request_id, model, channel_name, status, quota_consumed,
         latency_ms, error_msg, created_at,
         prompt_tokens, completion_tokens, price_markup, billing_detail
  FROM proxy_logs
`;

router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const where = "WHERE user_id = ?";
    const params: any[] = [userId];

    // execute 返回 [rows, fields]，Promise.all 后每项再解一层取 rows
    // LIMIT/OFFSET 为受约束的数字，直接内联（mysql2 execute 的 ? 占位符在 LIMIT 上会报错）
    const [[countRows], [logRows]] = await Promise.all([
      gatewayPool.execute(`SELECT COUNT(*) AS total FROM proxy_logs ${where}`, params),
      gatewayPool.execute(
        `${LOG_SELECT} ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
        params
      ),
    ]);

    const countRow = (countRows as any[])[0] ?? {};
    const rows = logRows as any[];

    const list = (rows as any[]).map((r) => ({
      id: r.id,
      request_id: r.request_id,
      model: r.model,
      channel_name: r.channel_name,
      status: r.status,
      cost_points: Number(r.quota_consumed) || 0,
      cost_amount: (Number(r.quota_consumed) || 0) / QUOTA_PER_YUAN,
      latency_ms: r.latency_ms,
      error_msg: r.error_msg,
      prompt_tokens: Number(r.prompt_tokens) || 0,
      completion_tokens: Number(r.completion_tokens) || 0,
      discount: r.price_markup == null ? null : Number(r.price_markup),
      billing_detail: r.billing_detail ?? null,
      created_at: r.created_at,
    }));

    res.json({
      logs: list,
      pagination: {
        page,
        pageSize,
        total: Number((countRow as any)?.total) || 0,
      },
    });
  } catch (err) {
    console.error("List logs error:", err);
    res.status(500).json({ error: "获取消费日志失败" });
  }
});

export default router;

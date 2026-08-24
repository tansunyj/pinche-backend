/**
 * 管理端消费日志（挂载 /api/admin/logs）
 *
 *   GET /                分页消费日志（proxy_logs，可按模型/Key/状态/用户名/时间过滤，附汇总）
 *   GET /request-detail  请求详情（合并表 proxy_logs，按 request_id / log_id / id 查询）
 *
 * 移植自 admin_backend/routes/dashboard.js 的 /logs 与 /request-detail（TS 化，adminAuth + gatewayPool）。
 * 额度口径与网关一致：1 元 = 100000 额度。
 */

import { Router, Request, Response } from "express";
import { gatewayPool } from "../../config/db";
import { adminAuth } from "../../middlewares/adminAuth";

const router = Router();
router.use(adminAuth);

const QUOTA_PER_YUAN = 100000;

function quotaToYuan(quota: any): number {
  return Math.round((Number(quota) / QUOTA_PER_YUAN) * 10000) / 10000;
}

// ============ 消费日志列表 ============
router.get("/", async (req: Request, res: Response) => {
  const { model, token_name, status, start_date, end_date, username } = req.query;
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "20"), 10)));
  const offset = (page - 1) * pageSize;

  try {
    const where: string[] = [];
    const params: any[] = [];

    if (model) { where.push("l.model = ?"); params.push(model); }
    if (token_name) {
      // 同时匹配令牌名称或 API KEY（模糊查询）
      where.push("(l.token_name LIKE ? OR t.`key` LIKE ?)");
      const like = `%${token_name}%`;
      params.push(like, like);
    }
    if (username) {
      where.push("(u.phone LIKE ? OR u.nickname LIKE ? OR u.email LIKE ?)");
      const like = `%${username}%`;
      params.push(like, like, like);
    }
    if (status) { where.push("l.status = ?"); params.push(status); }
    if (start_date) { where.push("l.created_at >= ?"); params.push(start_date); }
    if (end_date) {
      // 纯日期(YYYY-MM-DD)视为当天截止;带时间则原样比较
      where.push("l.created_at <= ?");
      params.push(/^\d{4}-\d{2}-\d{2}$/.test(String(end_date)) ? `${end_date} 23:59:59` : end_date);
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const fromTable =
      "proxy_logs l LEFT JOIN proxy_tokens t ON l.token_id = t.id LEFT JOIN pt_users u ON t.user_id = u.id";

    const [cntRows] = await gatewayPool.execute(
      `SELECT COUNT(*) AS cnt FROM ${fromTable} ${whereClause}`,
      params
    );
    const total = Number((cntRows as any[])[0]?.cnt || 0);

    const [logRows] = await gatewayPool.execute(
      `SELECT l.id, l.token_id, l.channel_id, l.request_id, l.channel_name, l.model,
              l.prompt_tokens, l.completion_tokens, l.quota_consumed, l.latency_ms,
              l.status, l.error_msg, l.is_thinking, l.price_markup, l.created_at,
              l.token_name, l.aborted, l.billing_detail,
              DATE_FORMAT(l.created_at, "%Y-%m-%d %H:%i:%s") AS created_at_fmt,
              t.\`key\` AS api_key,
              u.id AS user_id,
              COALESCE(u.email, u.phone, u.nickname) AS user_username
         FROM ${fromTable} ${whereClause}
        ORDER BY l.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    const [sumRows] = await gatewayPool.execute(
      `SELECT COALESCE(SUM(l.quota_consumed), 0) AS total_quota,
              COALESCE(SUM(l.prompt_tokens), 0) AS total_prompt,
              COALESCE(SUM(l.completion_tokens), 0) AS total_completion,
              COUNT(*) AS total_requests
         FROM ${fromTable} ${whereClause}`,
      params
    );
    const sum = (sumRows as any[])[0] ?? {};

    res.json({
      logs: (logRows as any[]).map((l) => ({
        id: l.id,
        tokenId: l.token_id,
        channelId: l.channel_id,
        requestId: l.request_id,
        tokenName: l.token_name || null,
        apiKey: l.api_key || null,
        username: l.user_username || null,
        userId: l.user_id || null,
        channelName: l.channel_name || "-",
        model: l.model,
        promptTokens: Number(l.prompt_tokens) || 0,
        completionTokens: Number(l.completion_tokens) || 0,
        costPoints: Number(l.quota_consumed) || 0,
        costYuan: quotaToYuan(l.quota_consumed),
        latencyMs: l.latency_ms,
        status: l.status,
        errorMsg: l.error_msg || null,
        isThinking: !!l.is_thinking,
        aborted: !!l.aborted,
        priceMarkup: l.price_markup == null ? 1.0 : Number(l.price_markup),
        billingDetail: l.billing_detail ?? null,
        createdAt: l.created_at_fmt || l.created_at,
      })),
      total,
      page,
      pageSize,
      summary: {
        totalCost: quotaToYuan(sum.total_quota),
        totalPrompt: Number(sum.total_prompt) || 0,
        totalCompletion: Number(sum.total_completion) || 0,
        totalRequests: Number(sum.total_requests) || 0,
      },
      isAdmin: true,
    });
  } catch (err) {
    console.error("Admin logs list error:", err);
    res.status(500).json({ error: "获取日志列表失败" });
  }
});

// ============ 请求/响应详情 ============
router.get("/request-detail", async (req: Request, res: Response) => {
  try {
    const { request_id, log_id, id } = req.query;
    let resolvedReqId: string | null = typeof request_id === "string" ? request_id : null;

    if (!resolvedReqId && log_id) {
      const [rows] = await gatewayPool.execute(
        "SELECT request_id FROM proxy_logs WHERE id = ? LIMIT 1",
        [log_id]
      );
      resolvedReqId = (rows as any[])[0]?.request_id || null;
      if (!resolvedReqId) {
        res.status(404).json({ error: "该消费记录未关联请求详情" });
        return;
      }
    }

    let detailRows: any;
    if (id) {
      [detailRows] = await gatewayPool.execute(
        `SELECT *,
                DATE_FORMAT(created_at, "%Y-%m-%d %H:%i:%s") AS created_at_fmt,
                DATE_FORMAT(completed_at, "%Y-%m-%d %H:%i:%s") AS completed_at_fmt
           FROM proxy_logs WHERE id = ? LIMIT 1`,
        [id]
      );
    } else if (resolvedReqId) {
      [detailRows] = await gatewayPool.execute(
        `SELECT *,
                DATE_FORMAT(created_at, "%Y-%m-%d %H:%i:%s") AS created_at_fmt,
                DATE_FORMAT(completed_at, "%Y-%m-%d %H:%i:%s") AS completed_at_fmt
           FROM proxy_logs WHERE request_id = ? ORDER BY id DESC LIMIT 1`,
        [resolvedReqId]
      );
    } else {
      res.status(400).json({ error: "请提供 request_id / log_id / id 之一" });
      return;
    }

    if (!detailRows || (detailRows as any[]).length === 0) {
      res.status(404).json({ error: "未找到详细请求日志（可能未采样或已过期）" });
      return;
    }

    const d = (detailRows as any[])[0];
    // 请求/应答数据（request_headers/request_body/request_size_bytes/response_headers/
    // response_body/response_size_bytes）已从 proxy_logs DROP COLUMN（仅入网关日志），
    // 详情只返回元数据。直接返回详情对象（与其它 admin GET 接口一致，前端 res.data 直取）。
    res.json({
      id: d.id,
      requestId: d.request_id,
      userId: d.user_id,
      tokenId: d.token_id,
      channelId: d.channel_id,
      model: d.model,
      requestMethod: d.request_method,
      requestPath: d.request_path,
      responseStatus: d.response_status,
      isStream: !!d.is_stream,
      streamChunks: d.stream_chunks,
      firstChunkLatencyMs: d.first_chunk_latency_ms,
      totalLatencyMs: d.latency_ms,
      promptTokens: d.prompt_tokens,
      completionTokens: d.completion_tokens,
      totalTokens: d.total_tokens,
      costPoints: d.quota_consumed,
      errorMessage: d.error_msg,
      clientIp: d.client_ip,
      userAgent: d.user_agent,
      billingDetail: d.billing_detail,
      priceMarkup: d.price_markup,
      createdAt: d.created_at_fmt || d.created_at,
      completedAt: d.completed_at_fmt || d.completed_at,
    });
  } catch (err) {
    console.error("Admin logs request-detail error:", err);
    res.status(500).json({ error: "查询日志详情失败" });
  }
});

export default router;

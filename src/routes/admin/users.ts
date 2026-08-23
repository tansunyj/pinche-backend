/**
 * 管理端用户（挂载 /api/admin/users）
 *
 *   GET    /                       分页用户列表（pt_users，余额含在表中）
 *   GET    /:id                    用户详情（余额 / 充值统计）
 *   GET    /:id/discounts          该用户全部网关折扣（含已失效）
 *   POST   /:id/status             启用/禁用拼车侧账号
 *   POST   /:id/balance            余额调整（±额度，超管；写 balance + cumulative_recharge）
 */

import { Router, Request, Response } from "express";
import { cpQuery, gatewayPool, carpoolPool } from "../../config/db";
import { adminAuth, requireSuperAdmin } from "../../middlewares/adminAuth";
import redis from "../../utils/redis";

const router = Router();
router.use(adminAuth);

router.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || "20"), 10)));
    const search = String(req.query.search || "").trim();
    const offset = (page - 1) * pageSize;

    const like = `%${search}%`;
    const where = search ? "WHERE u.phone LIKE ? OR u.nickname LIKE ? OR u.email LIKE ?" : "";
    const params = search ? [like, like, like] : [];

    const totalRows = await cpQuery(`SELECT COUNT(*) AS cnt FROM pt_users u ${where}`, params);
    const total = Number((Array.isArray(totalRows) ? totalRows[0] : totalRows).cnt || 0);

    const rows = await cpQuery(
      `SELECT u.* FROM pt_users u ${where} ORDER BY u.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );
    const list = Array.isArray(rows) ? rows : [];

    // 每用户上车数
    const ridesMap = new Map<number, number>();
    const ptIds = list.map((u: any) => u.id);
    if (ptIds.length > 0) {
      const [mRows] = await carpoolPool.execute(
        `SELECT user_id, COUNT(*) AS cnt FROM pt_ride_members WHERE status='ACTIVE' AND user_id IN (${ptIds.map(() => "?").join(",")}) GROUP BY user_id`,
        ptIds
      );
      for (const m of mRows as any[]) ridesMap.set(Number(m.user_id), Number(m.cnt));
    }

    res.json({
      total,
      page,
      pageSize,
      users: list.map((u: any) => {
        return {
          id: u.id,
          phone: u.phone,
          email: u.email,
          nickname: u.nickname,
          avatarUrl: u.avatar_url,
          status: u.status,
          createdAt: u.created_at,
          // 钱包余额（额度值）与累计充值（额度值 /100000 转元，1元=100000额度）；
          // 累计充值读 pt_users.cumulative_recharge（含手动余额调整），而非支付订单表
          balance: Number(u.balance) || 0,
          totalRechargedYuan: (Number(u.cumulative_recharge) || 0) / 100000,
          rideCount: ridesMap.get(Number(u.id)) || 0,
        };
      }),
    });
  } catch (err) {
    console.error("Admin users list error:", err);
    res.status(500).json({ error: "获取用户列表失败" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const rows = await cpQuery("SELECT * FROM pt_users WHERE id = ? LIMIT 1", [req.params.id]);
    const user = Array.isArray(rows) ? rows[0] : null;
    if (!user) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }

    const [payments] = await cpQuery(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_yuan), 0) AS total_yuan FROM pt_payments WHERE user_id = ? AND status = 'SUCCESS'",
      [user.id]
    );

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        nickname: user.nickname,
        avatarUrl: user.avatar_url,
        status: user.status,
        balance: Number(user.balance) || 0,
        createdAt: user.created_at,
      },
      stats: {
        // 车次已不再读写 user_model_discounts，折扣统计置空
        discountTotal: 0,
        discountActive: 0,
        paymentTotal: Number((Array.isArray(payments) && payments.length ? payments[0] : payments).cnt || 0),
        paymentAmountYuan: Number((Array.isArray(payments) && payments.length ? payments[0] : payments).total_yuan || 0),
      },
    });
  } catch (err) {
    console.error("Admin user detail error:", err);
    res.status(500).json({ error: "获取用户详情失败" });
  }
});

router.get("/:id/discounts", async (_req: Request, res: Response) => {
  // 车次已不再读写 user_model_discounts，统一返回空
  res.json({ discounts: [] });
});

router.post("/:id/status", async (req: Request, res: Response) => {
  try {
    const status = req.body?.status === "DISABLED" ? "DISABLED" : "ACTIVE";
    const [ur] = await carpoolPool.execute("UPDATE pt_users SET status = ? WHERE id = ?", [status, req.params.id]);
    if ((ur as any).affectedRows === 0) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }
    res.json({ success: true, status, message: status === "DISABLED" ? "已禁用该账号" : "已恢复该账号" });
  } catch (err) {
    console.error("Admin user status error:", err);
    res.status(500).json({ error: "操作失败" });
  }
});

// ============ 余额调整（± 额度，写 pt_users.balance / cumulative_recharge） ============
// body: { amountCents: number, reason?: string }
//   amountCents 单位「分」，正=增加，负=减少（如 +12345 = +123.45 元）
//   1 元 = 100 分 = 100000 额度 → 1 分 = 1000 额度
// 仅超管（与 payments retry 等敏感操作一致）。允许负余额（用户已确认，不加下限校验）。
router.post("/:id/balance", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: "用户 ID 不合法" });
      return;
    }

    const amountCents = Number(req.body?.amountCents);
    if (!Number.isInteger(amountCents) || amountCents === 0) {
      res.status(400).json({ error: "调整金额必须是非零整数（单位：分）" });
      return;
    }

    // 用户存在校验 + 取调整前余额
    const rows = await cpQuery("SELECT balance, cumulative_recharge FROM pt_users WHERE id = ? LIMIT 1", [userId]);
    const user = Array.isArray(rows) ? rows[0] : null;
    if (!user) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }

    const previousBalance = Number(user.balance) || 0;
    const previousCumulativeRecharge = Number(user.cumulative_recharge) || 0;
    const quotaDelta = amountCents * 1000; // 1 分 = 1000 额度

    // 相对更新（照抄 credit.ts 的到账写法）：balance 与 cumulative_recharge 同增同减
    const [ur] = await carpoolPool.execute(
      "UPDATE pt_users SET balance = balance + ?, cumulative_recharge = cumulative_recharge + ? WHERE id = ?",
      [quotaDelta, quotaDelta, userId]
    );
    if ((ur as any).affectedRows === 0) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }

    // ⚠️ 必须删网关读的冒号键 user:balance:{userId}（TTL 10min），否则网关读旧值；
    //    不能学 credit.ts 的下划线键 user_balance:（那是 bug）
    await redis.del(`user:balance:${userId}`);

    res.json({
      success: true,
      message: "余额调整成功",
      amountCents,
      quotaDelta,
      previousBalance,
      newBalance: previousBalance + quotaDelta,
      previousCumulativeRecharge,
      newCumulativeRecharge: previousCumulativeRecharge + quotaDelta,
    });
  } catch (err) {
    console.error("Admin user balance adjust error:", err);
    res.status(500).json({ error: "调整余额失败" });
  }
});

/** proxy_tokens.models 兼容 JSON 数组 / 逗号分隔字符串 */
function parseModels(raw: any): string[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 逗号分隔
    }
    return raw.split(",").filter((m: string) => m.trim());
  }
  if (Array.isArray(raw)) return raw;
  return [];
}

// ============ 该用户的 API Key 列表（跨用户，读网关 proxy_tokens，user_id=pt_users.id） ============
router.get("/:id/tokens", async (req: Request, res: Response) => {
  try {
    const ptUserId = Number(req.params.id);
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || "20"), 10)));
    const offset = (page - 1) * pageSize;

    const [tokens] = await gatewayPool.execute(
      `SELECT t.id, t.name, t.\`key\`, t.quota, t.used_quota, t.rate_limit_rpm, t.models,
              t.status, t.price_markup, t.channel_id, c.name AS channel_name,
              t.created_at, t.start_at, t.expired_at
         FROM proxy_tokens t
         LEFT JOIN proxy_channels c ON t.channel_id = c.id
        WHERE t.user_id = ?
        ORDER BY t.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      [ptUserId]
    );
    const [cntRows] = await gatewayPool.execute("SELECT COUNT(*) AS cnt FROM proxy_tokens WHERE user_id = ?", [ptUserId]);
    const total = Number((cntRows as any[])[0]?.cnt || 0);

    res.json({
      tokens: (tokens as any[]).map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
        quota: t.quota || 0,
        usedQuota: t.used_quota || 0,
        rateLimitRpm: t.rate_limit_rpm || 0,
        priceMarkup: t.price_markup != null ? Number(t.price_markup) : 1.0,
        channelId: t.channel_id,
        channelName: t.channel_name || null,
        models: parseModels(t.models),
        status: t.status,
        createdAt: t.created_at,
        startAt: t.start_at,
        expiredAt: t.expired_at,
      })),
      pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    console.error("Admin user tokens error:", err);
    res.status(500).json({ error: "获取用户 Key 列表失败" });
  }
});

// ============ 切换该用户某个 Key 的启停 ============
router.put("/:id/tokens/:tokenId/status", async (req: Request, res: Response) => {
  try {
    const status = Number(req.body?.status);
    if (status !== 0 && status !== 1) {
      res.status(400).json({ error: "status 必须是 0（禁用）或 1（启用）" });
      return;
    }
    const ptUserId = Number(req.params.id);
    const [r] = await gatewayPool.execute(
      "UPDATE proxy_tokens SET status = ? WHERE id = ? AND user_id = ?",
      [status, req.params.tokenId, ptUserId]
    );
    if ((r as any).affectedRows === 0) {
      res.status(404).json({ error: "Key 不存在或不属于该用户" });
      return;
    }
    res.json({ success: true, message: status === 1 ? "Key 已启用" : "Key 已禁用" });
  } catch (err) {
    console.error("Admin user token status error:", err);
    res.status(500).json({ error: "操作失败" });
  }
});

// ============ 删除该用户某个 Key ============
router.delete("/:id/tokens/:tokenId", async (req: Request, res: Response) => {
  try {
    const ptUserId = Number(req.params.id);
    const [r] = await gatewayPool.execute(
      "DELETE FROM proxy_tokens WHERE id = ? AND user_id = ?",
      [req.params.tokenId, ptUserId]
    );
    if ((r as any).affectedRows === 0) {
      res.status(404).json({ error: "Key 不存在或不属于该用户" });
      return;
    }
    res.json({ success: true, message: "Key 已删除" });
  } catch (err) {
    console.error("Admin user token delete error:", err);
    res.status(500).json({ error: "删除失败" });
  }
});

export default router;

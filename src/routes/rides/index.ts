/**
 * 车次（挂载 /api/rides）
 *
 *   GET  /           车次列表（可上车 + 更多车次）
 *   GET  /:token     车次详情（分享页）
 *   POST /:id/join   上车（用户 JWT，免费激活折扣）
 *
 * 车次仅对已上线（ACTIVE）的展示；待上线（PENDING）用户端不可见、不可上车。
 */

import { Router, Request, Response } from "express";
import { param } from "express-validator";
import { cpQuery } from "../../config/db";
import { verifyToken } from "../../utils/jwt";
import redis from "../../utils/redis";
import { userAuth } from "../../middlewares/userAuth";
import { joinRide, getRideGroups, RideError } from "../../services/ride";

const router = Router();

/** 可选登录：解析用户 JWT（不强制），供详情页已上车判断 */
async function optionalUser(req: Request): Promise<number | null> {
  const authHeader = req.headers.authorization;
  const token =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const blacklisted = await redis.get(`pt:bl:${token}`);
    if (blacklisted) return null;
    const decoded = verifyToken(token);
    return decoded.userId ?? null;
  } catch {
    return null;
  }
}

// ============ 车次列表 ============
router.get("/", async (req: Request, res: Response) => {
  try {
    // —— 可上车车次（主列表）：已上线 + 未发车 + 未截止，按最低折扣率升序 ——
    const joinable = await cpQuery(
      `SELECT r.id, r.name, r.description, r.current_count,
              r.min_count, r.start_time, r.end_time, r.established_at, r.share_token,
              MIN(IFNULL(g.discount_rate, 1)) AS min_discount_rate
       FROM pt_rides r
       LEFT JOIN pt_ride_groups g ON g.ride_id = r.id
       WHERE r.status = 'ACTIVE'
         AND r.enroll_type = 'PUBLIC'
         AND (r.start_time IS NULL OR r.start_time > NOW())
         AND (r.end_time IS NULL OR r.end_time > NOW())
       GROUP BY r.id
       ORDER BY min_discount_rate ASC, r.id DESC`
    );

    // —— 更多车次（已截止，社会认同）：近 7 天 ——
    const more = await cpQuery(
      `SELECT r.id, r.name, r.current_count, r.status,
              r.start_time, r.end_time,
              MIN(IFNULL(g.discount_rate, 1)) AS min_discount_rate,
              COALESCE(r.end_time, r.created_at) AS ended_at
       FROM pt_rides r
       LEFT JOIN pt_ride_groups g ON g.ride_id = r.id
       WHERE r.status IN ('EXPIRED')
         AND r.enroll_type = 'PUBLIC'
         AND COALESCE(r.end_time, r.created_at) > DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY r.id
       ORDER BY ended_at DESC`
    );

    const formatJoinable = (r: any) => {
      const end = r.end_time ? new Date(r.end_time).getTime() : null;
      const remainingMs = end ? end - Date.now() : null;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        currentCount: Number(r.current_count),
        minCount: Number(r.min_count),
        minDiscountRate: Number(r.min_discount_rate),
        shareToken: r.share_token,
        startTime: r.start_time,
        endTime: r.end_time,
        establishedAt: r.established_at,
        // 紧迫感标识（仅临近截止）
        almostExpired: remainingMs !== null && remainingMs <= 24 * 60 * 60 * 1000,
      };
    };

    const formatMore = (r: any) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      minDiscountRate: Number(r.min_discount_rate),
      startTime: r.start_time,
      endTime: r.end_time,
      endedAt: r.ended_at,
      label: "已截止",
    });

    res.json({
      joinable: (Array.isArray(joinable) ? joinable : []).map(formatJoinable),
      more: (Array.isArray(more) ? more : []).map(formatMore),
    });
  } catch (err) {
    console.error("List rides error:", err);
    res.status(500).json({ error: "获取车次列表失败" });
  }
});

// ============ 车次详情（分享页） ============
router.get("/:token", async (req: Request, res: Response) => {
  try {
    const rides = await cpQuery("SELECT * FROM pt_rides WHERE share_token = ? LIMIT 1", [req.params.token]);
    const ride = Array.isArray(rides) ? rides[0] : null;
    // 待上线（PENDING）/未成团取消（CANCELLED）车次用户端一律不可见
    if (!ride || ride.status === "PENDING" || ride.status === "CANCELLED") {
      res.status(404).json({ error: "车次不存在或已下线" });
      return;
    }
    const groups = await getRideGroups(ride.id);
    const ptUserId = await optionalUser(req);
    let joined = false;
    if (ptUserId) {
      const ms = await cpQuery(
        "SELECT id FROM pt_ride_members WHERE ride_id = ? AND user_id = ? AND status = 'ACTIVE' LIMIT 1",
        [ride.id, ptUserId]
      );
      joined = Array.isArray(ms) && ms.length > 0;
    }

    // 管理员拉人型：仅该车次 ACTIVE 成员可见（未上车的用户一律视为不存在）
    if (ride.enroll_type === "ADMIN_ONLY" && !joined) {
      res.status(404).json({ error: "车次不存在或已下线" });
      return;
    }

    // §6.3 该车次累计节省额度（ride 维度，历史累计）
    const savedRows = await cpQuery(
      `SELECT COALESCE(SUM(metric_value),0) AS saved FROM unified_stats
       WHERE dim_type='ride' AND dim1_key=? AND metric_name='ride_saved_quota' AND stat_hour=-1`,
      [`ride:${ride.id}`]
    );
    const current = Number(ride.current_count);
    const min = Number(ride.min_count);

    res.json({
      ride: {
        id: ride.id,
        name: ride.name,
        description: ride.description,
        status: ride.status,
        enrollType: ride.enroll_type,
        currentCount: current,
        minCount: min,
        startTime: ride.start_time,
        endTime: ride.end_time,
        establishedAt: ride.established_at,
        createdAt: ride.created_at,
        // §6.3 达成与节省：进度条 + 解锁剩余 + 累计节省额度
        progress: min > 0 ? Math.min(100, Math.round((current / min) * 100)) : 0,
        remainingToUnlock: Math.max(min - current, 0),
        savedQuota: Number((savedRows as any[])[0]?.saved) || 0,
      },
      groups,
      joined,
    });
  } catch (err) {
    console.error("Get ride detail error:", err);
    res.status(500).json({ error: "获取车次详情失败" });
  }
});

// ============ 上车 ============
router.post(
  "/:id/join",
  userAuth,
  [param("id").isInt().toInt()],
  async (req: Request, res: Response) => {
    try {
      const ptUserId = req.user!.userId;
      if (!ptUserId) {
        res.status(400).json({ error: "请先完成开户（重新登录）" });
        return;
      }
      const result = await joinRide({
        rideId: Number(req.params.id),
        ptUserId,
      });
      res.json({
        message: result.already ? "您已在该车次上" : "上车成功",
        ...result,
      });
    } catch (err: any) {
      if (err instanceof RideError) {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error("Join ride error:", err);
      res.status(500).json({ error: "上车失败，请稍后重试" });
    }
  }
);

export default router;

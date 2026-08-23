/**
 * 我的车次（挂载 /api/user/rides）
 */

import { Router, Request, Response } from "express";
import { cpQuery } from "../../config/db";
import { userAuth } from "../../middlewares/userAuth";

const router = Router();
router.use(userAuth);

router.get("/", async (req: Request, res: Response) => {
  try {
    const ptUserId = req.user!.userId;
    if (!ptUserId) {
      res.json({ rides: [] });
      return;
    }
    const rows = await cpQuery(
      `SELECT r.id, r.name, r.description, r.start_time, r.end_time,
              r.status AS ride_status, r.current_count, r.min_count,
              r.established_at, r.share_token,
              rm.joined_at,
              (SELECT MIN(discount_rate) FROM pt_ride_groups g WHERE g.ride_id = r.id) AS min_discount_rate
       FROM pt_ride_members rm
       JOIN pt_rides r ON r.id = rm.ride_id
       WHERE rm.user_id = ? AND rm.status = 'ACTIVE'
       ORDER BY rm.joined_at DESC`,
      [ptUserId]
    );

    res.json({
      rides: (Array.isArray(rows) ? rows : []).map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        startTime: r.start_time,
        endTime: r.end_time,
        rideStatus: r.ride_status,
        currentCount: Number(r.current_count),
        minCount: Number(r.min_count),
        minDiscountRate: r.min_discount_rate === null ? null : Number(r.min_discount_rate),
        establishedAt: r.established_at,
        shareToken: r.share_token,
        joinedAt: r.joined_at,
      })),
    });
  } catch (err) {
    console.error("My rides error:", err);
    res.status(500).json({ error: "获取我的车次失败" });
  }
});

export default router;

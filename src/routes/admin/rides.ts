/**
 * 管理端车次（挂载 /api/admin/rides）
 *
 *   GET    /                       分页车次列表（全部状态）
 *   GET    /:id                    车次详情（含分组 + 成员）
 *   POST   /                       发车（仅超管，createRide，默认待上线）
 *   PUT    /:id                    编辑车次（仅超管，updateRide；重建分组并重写成员折扣）
 *   POST   /:id/status             上线/待上线开关（仅超管，setRideStatus）
 *   POST   /:id/close              关闭车次并撤销全部折扣（仅超管）
 *   POST   /:id/members/:userId/kick  请出成员并撤销其折扣（仅超管）
 */

import { Router, Request, Response } from "express";
import { cpQuery } from "../../config/db";
import { adminAuth, requireSuperAdmin } from "../../middlewares/adminAuth";
import { createRide, closeRide, getRideGroups, kickRideMember, setRideStatus, updateRide, RideError } from "../../services/ride";

const router = Router();
router.use(adminAuth);

// ============ 车次列表 ============
router.get("/", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || "20"), 10)));
    const status = String(req.query.status || "").trim();
    const offset = (page - 1) * pageSize;

    const conds: string[] = [];
    const params: any[] = [];
    if (status) { conds.push("status = ?"); params.push(status); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const totalRows = await cpQuery(`SELECT COUNT(*) AS cnt FROM pt_rides ${where}`, params);
    const total = Number((Array.isArray(totalRows) ? totalRows[0] : totalRows).cnt || 0);

    const rows = await cpQuery(
      `SELECT r.*,
              (SELECT MIN(discount_rate) FROM pt_ride_groups g WHERE g.ride_id = r.id) AS min_discount_rate,
              (SELECT COUNT(*) FROM pt_ride_members m WHERE m.ride_id = r.id AND m.status='ACTIVE') AS member_count
       FROM pt_rides r
       ${where}
       ORDER BY r.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    res.json({
      total,
      page,
      pageSize,
      rides: (Array.isArray(rows) ? rows : []).map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        currentCount: Number(r.current_count),
        minCount: Number(r.min_count),
        memberCount: Number(r.member_count || r.current_count),
        minDiscountRate: r.min_discount_rate === null ? null : Number(r.min_discount_rate),
        startTime: r.start_time,
        endTime: r.end_time,
        establishedAt: r.established_at,
        shareToken: r.share_token,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Admin rides list error:", err);
    res.status(500).json({ error: "获取车次列表失败" });
  }
});

// ============ 车次可选模型（按渠道查询，modelId 带渠道前缀，如 aliyun/qwen3.6-flash） ============
// 同一模型名可能挂在多个渠道下，必须带渠道 code 区分；不从模型库直接取
router.get("/models", async (req: Request, res: Response) => {
  try {
    const search = String(req.query.search || "").trim();
    const conds: string[] = ["cm.is_enabled = 1", "c.status = 1", "ml.status = 1"];
    const params: any[] = [];
    if (search) {
      conds.push("(cm.model_id LIKE ? OR c.channel_code LIKE ? OR CONCAT(c.channel_code, '/', cm.model_id) LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const where = `WHERE ${conds.join(" AND ")}`;

    const rows = await cpQuery(
      `SELECT c.channel_code, cm.model_id, ml.display_name, ml.category, ml.is_hot
       FROM proxy_channel_models cm
       JOIN proxy_channels c ON c.id = cm.channel_id
       JOIN model_library ml ON ml.model_id = cm.model_id
       ${where}
       ORDER BY ml.sort_order ASC, c.channel_code ASC, cm.model_id ASC
       LIMIT 500`
    );

    res.json({
      models: (Array.isArray(rows) ? rows : []).map((m: any) => ({
        modelId: `${m.channel_code}/${m.model_id}`,
        displayName: `${m.channel_code}/${m.model_id}`,
        category: m.category,
        isHot: !!m.is_hot,
      })),
    });
  } catch (err) {
    console.error("Admin ride models error:", err);
    res.status(500).json({ error: "获取车次可选模型失败" });
  }
});

// ============ 车次详情 ============
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const rows = await cpQuery("SELECT * FROM pt_rides WHERE id = ? LIMIT 1", [req.params.id]);
    const ride = Array.isArray(rows) ? rows[0] : null;
    if (!ride) {
      res.status(404).json({ error: "车次不存在" });
      return;
    }
    const groups = await getRideGroups(ride.id);
    const members = await cpQuery(
      `SELECT m.id, m.user_id, m.joined_at, m.kicked_at, m.status, m.total_consumption, m.last_consumption_at,
              u.email, u.phone, u.nickname
       FROM pt_ride_members m
       LEFT JOIN pt_users u ON u.id = m.user_id
       WHERE m.ride_id = ?
       ORDER BY m.joined_at ASC`,
      [ride.id]
    );
    res.json({
      ride: {
        id: ride.id,
        name: ride.name,
        description: ride.description,
        status: ride.status,
        currentCount: Number(ride.current_count),
        minCount: Number(ride.min_count),
        startTime: ride.start_time,
        endTime: ride.end_time,
        establishedAt: ride.established_at,
        shareToken: ride.share_token,
        createdAt: ride.created_at,
      },
      groups,
      members: Array.isArray(members) ? members : [],
    });
  } catch (err) {
    console.error("Admin ride detail error:", err);
    res.status(500).json({ error: "获取车次详情失败" });
  }
});

// ============ 发车 ============
router.post("/", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const rideId = await createRide({
      name: body.name,
      description: body.description,
      startTime: body.startTime ? new Date(body.startTime) : null,
      endTime: body.endTime ? new Date(body.endTime) : null,
      minCount: Number(body.minCount),
      groups: Array.isArray(body.groups) ? body.groups : [],
      adminId: req.admin!.adminId,
    });
    res.json({ success: true, id: rideId, message: "发车成功（待上线）" });
  } catch (err: any) {
    if (err instanceof RideError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Admin create ride error:", err);
    res.status(500).json({ error: "发车失败" });
  }
});

// ============ 编辑车次 ============
router.put("/:id", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    await updateRide({
      rideId: Number(req.params.id),
      name: body.name,
      description: body.description,
      startTime: body.startTime ? new Date(body.startTime) : null,
      endTime: body.endTime ? new Date(body.endTime) : null,
      minCount: Number(body.minCount),
      status: body.status === "PENDING" || body.status === "ACTIVE" ? body.status : undefined,
      groups: Array.isArray(body.groups) ? body.groups : [],
    });
    res.json({ success: true, message: "车次已更新" });
  } catch (err: any) {
    if (err instanceof RideError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Admin update ride error:", err);
    res.status(500).json({ error: "更新车次失败" });
  }
});

// ============ 上线/待上线开关 ============
router.post("/:id/status", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const status = String((req.body || {}).status || "");
    if (status !== "PENDING" && status !== "ACTIVE") {
      res.status(400).json({ error: "status 必须为 PENDING 或 ACTIVE" });
      return;
    }
    const result = await setRideStatus(Number(req.params.id), status);
    res.json({ success: true, ...result });
  } catch (err: any) {
    if (err instanceof RideError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Admin set ride status error:", err);
    res.status(500).json({ error: "更新车次状态失败" });
  }
});

// ============ 关闭车次 ============
router.post("/:id/close", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    await closeRide(Number(req.params.id));
    res.json({ success: true, message: "车次已关闭" });
  } catch (err) {
    console.error("Admin close ride error:", err);
    res.status(500).json({ error: "关闭车次失败" });
  }
});

// ============ 请出成员 ============
router.post("/:id/members/:userId/kick", requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const result = await kickRideMember(Number(req.params.id), Number(req.params.userId));
    if (!result.ok) {
      res.status(400).json({ error: result.message });
      return;
    }
    res.json({ success: true, message: result.message });
  } catch (err) {
    console.error("Admin kick member error:", err);
    res.status(500).json({ error: "请出成员失败" });
  }
});

export default router;

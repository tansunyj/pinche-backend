/**
 * 上车服务（§2.2 上车流程）
 *
 * 车次只做成员管理（抢名额 + 记录成员），不再与网关 user_model_discounts 有任何读写。
 *
 * 车次模型：开始/结束时间 + 上线开关 + 最低成团人数（无满员上限）
 *   - status: PENDING(待上线) → ACTIVE(上线) → EXPIRED/CLOSED / CANCELLED(未成团取消)
 *   - 达到 min_count 自动成团（established_at 锁存，不回退）
 *   - 发车时间(start_time)后截止加入；未成团到发车时间由 cron 自动取消
 */

import { cpQuery, carpoolPool, cpTransaction } from "../config/db";

export class RideError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** 上车方式：PUBLIC=乘客自行上车(默认) / ADMIN_ONLY=仅管理员拉人 */
export type EnrollType = "PUBLIC" | "ADMIN_ONLY";

export async function getRideGroups(rideId: number) {
  const groups = await cpQuery(
    "SELECT * FROM pt_ride_groups WHERE ride_id = ? ORDER BY display_order ASC, id ASC",
    [rideId]
  );
  const models = await cpQuery(
    "SELECT g.id AS group_id, m.model_id, m.model_name FROM pt_ride_group_models m JOIN pt_ride_groups g ON g.id = m.group_id WHERE m.ride_id = ? ORDER BY g.display_order ASC, m.id ASC",
    [rideId]
  );
  const byGroup = new Map<number, any[]>();
  for (const m of models as any[]) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id)!.push({ modelId: m.model_id, modelName: m.model_name });
  }
  return (groups as any[]).map((g) => ({
    id: g.id,
    discountRate: Number(g.discount_rate),
    displayOrder: g.display_order,
    models: byGroup.get(g.id) || [],
  }));
}

/**
 * 上车（幂等 + 条件更新防超卖）
 */
export async function joinRide(input: {
  rideId: number;
  ptUserId: number;
}): Promise<{ already: boolean; rideName: string }> {
  const { rideId, ptUserId } = input;

  // 1. 校验车次
  const rides = await cpQuery("SELECT * FROM pt_rides WHERE id = ? LIMIT 1", [rideId]);
  const ride = Array.isArray(rides) ? rides[0] : null;
  if (!ride) throw new RideError("RIDE_NOT_FOUND", "车次不存在");

  if (ride.status === "PENDING") throw new RideError("RIDE_NOT_ONLINE", "车次尚未上线");
  if (ride.status !== "ACTIVE") throw new RideError("RIDE_CLOSED", "车次不可上车");
  if (ride.end_time && new Date(ride.end_time) < new Date()) {
    throw new RideError("RIDE_EXPIRED", "车次已截止");
  }
  if (ride.start_time && new Date(ride.start_time) <= new Date()) {
    throw new RideError("RIDE_DEPARTED", "车次已发车");
  }

  // 2. 幂等：已上车直接返回
  const members = await cpQuery(
    "SELECT * FROM pt_ride_members WHERE ride_id = ? AND user_id = ? LIMIT 1",
    [rideId, ptUserId]
  );
  const member = Array.isArray(members) && members.length > 0 ? members[0] : null;
  if (member && member.status === "ACTIVE") {
    return { already: true, rideName: ride.name };
  }

  // 管理员拉人型：乘客不能自行上车（含 KICKED 复活也仅能由管理员触发）
  if (ride.enroll_type === "ADMIN_ONLY") {
    throw new RideError("RIDE_ADMIN_ONLY", "该车次仅支持管理员添加成员");
  }

  // 3. 抢名额（条件更新防超卖：仅当 ACTIVE 才 +1；无满员上限）
  const [ur] = await carpoolPool.execute(
    "UPDATE pt_rides SET current_count = current_count + 1 WHERE id = ? AND status = 'ACTIVE'",
    [rideId]
  );
  if ((ur as any).affectedRows === 0) {
    throw new RideError("RIDE_CLOSED", "车次不可上车");
  }

  // 4. 记录成员（KICKED 后重新上车 → 恢复 ACTIVE）
  await cpQuery("INSERT IGNORE INTO pt_ride_members (ride_id, user_id) VALUES (?, ?)", [rideId, ptUserId]);
  if (member && member.status === "KICKED") {
    await cpQuery(
      "UPDATE pt_ride_members SET status = 'ACTIVE', kicked_at = NULL WHERE ride_id = ? AND user_id = ?",
      [rideId, ptUserId]
    );
  }

  // 5. 成团锁存：达到最低人数 → 自动成立（一次性，不回退；无满员上限）
  await cpQuery(
    `UPDATE pt_rides SET established_at = COALESCE(established_at, NOW())
     WHERE id = ? AND established_at IS NULL AND current_count >= min_count`,
    [rideId]
  );

  return { already: false, rideName: ride.name };
}

/**
 * 手动关闭车次：置状态 CLOSED（不涉及网关折扣表）
 */
export async function closeRide(rideId: number): Promise<void> {
  await cpQuery("UPDATE pt_rides SET status = 'CLOSED' WHERE id = ? AND status != 'CLOSED'", [rideId]);
}

/**
 * 生成分享 token（8 位随机，创建车次时始终生成）
 */
async function generateShareToken(): Promise<string> {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < 5; i++) {
    let t = "";
    for (let j = 0; j < 8; j++) t += chars[Math.floor(Math.random() * chars.length)];
    const dup = await cpQuery("SELECT id FROM pt_rides WHERE share_token = ?", [t]);
    if (!Array.isArray(dup) || dup.length === 0) return t;
  }
  throw new RideError("TOKEN_GEN_FAILED", "分享链接生成失败，请重试");
}

/** 车次分组（折扣档位）：无名称，只含折扣率 + 模型列表 */
type RideGroupInput = {
  discountRate: number;
  models: { modelId: string; modelName?: string }[];
};

/** 时间校验：开始时间必填；结束时间可选（不设即永久车次），设置了则到期结束且必须晚于开始 */
function validateTimeRange(startTime?: Date | null, endTime?: Date | null): void {
  if (!startTime) throw new RideError("INVALID_PARAMS", "车次开始时间必填");
  const start = new Date(startTime);
  if (isNaN(start.getTime())) throw new RideError("INVALID_PARAMS", "车次时间格式不正确");
  if (endTime) {
    const end = new Date(endTime);
    if (isNaN(end.getTime())) throw new RideError("INVALID_PARAMS", "车次时间格式不正确");
    if (end <= start) throw new RideError("INVALID_PARAMS", "结束时间必须晚于开始时间");
  }
}

/** 分组校验：非空、每组有模型、折扣率 (0,1]、全车模型不重复 */
function validateGroups(groups: RideGroupInput[]): void {
  if (!groups || groups.length === 0) throw new RideError("INVALID_GROUPS", "至少需要一个折扣档位");
  const seenModels = new Set<string>();
  for (const g of groups) {
    if (!g.models || g.models.length === 0) throw new RideError("INVALID_GROUPS", "每个折扣档位至少需要一个模型");
    if (!(g.discountRate >= 0 && g.discountRate <= 1)) {
      throw new RideError("INVALID_GROUPS", "折扣率必须在 0-1 之间");
    }
    for (const m of g.models) {
      if (seenModels.has(m.modelId)) throw new RideError("DUPLICATE_MODEL", `模型 ${m.modelId} 在车次中重复`);
      seenModels.add(m.modelId);
    }
  }
}

/**
 * 发车（创建车次）：默认待上线（PENDING），管理员编辑确认后再拨上线。
 * groups: [{ discountRate, models: [{ modelId, modelName? }] }]
 */
export async function createRide(input: {
  name: string;
  description?: string;
  startTime?: Date | null;
  endTime?: Date | null;
  minCount: number;
  groups: RideGroupInput[];
  adminId: number;
  enrollType?: EnrollType;
}): Promise<number> {
  const { name, description, startTime, endTime, minCount, groups, adminId } = input;
  const enrollType: EnrollType = input.enrollType === "ADMIN_ONLY" ? "ADMIN_ONLY" : "PUBLIC";

  // —— 参数校验 ——
  if (!name || name.trim().length === 0) throw new RideError("INVALID_PARAMS", "车次名称必填");
  if (!Number.isInteger(minCount) || minCount < 1) {
    throw new RideError("INVALID_PARAMS", "最低成团人数至少 1 人");
  }
  validateTimeRange(startTime, endTime);
  validateGroups(groups);

  // 管理员拉人型：忽略成团人数（创建即视为已成立，折扣随发车时间生效）
  const effectiveMinCount = enrollType === "ADMIN_ONLY" ? 1 : minCount;
  const establishedAt = enrollType === "ADMIN_ONLY" ? new Date() : null;

  // —— 分享 token 始终生成 ——
  const shareToken = await generateShareToken();

  // —— 事务写入（status 默认 PENDING 待上线） ——
  const rideId = await cpTransaction(async (conn) => {
    const [r] = await conn.execute(
      `INSERT INTO pt_rides (name, description, min_count, start_time, end_time, status, enroll_type, established_at, share_token, created_by)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
      [name.trim(), description || null, effectiveMinCount, startTime || null, endTime || null, enrollType, establishedAt, shareToken, adminId]
    );
    const newRideId = Number((r as any).insertId);

    let order = 0;
    for (const g of groups) {
      const [gr] = await conn.execute(
        "INSERT INTO pt_ride_groups (ride_id, discount_rate, display_order) VALUES (?, ?, ?)",
        [newRideId, g.discountRate, order]
      );
      const groupId = Number((gr as any).insertId);
      for (const m of g.models) {
        await conn.execute(
          "INSERT INTO pt_ride_group_models (group_id, ride_id, model_id, model_name) VALUES (?, ?, ?, ?)",
          [groupId, newRideId, m.modelId, m.modelName || m.modelId]
        );
      }
      order++;
    }

    return newRideId;
  });

  return rideId;
}

/** 按当前 end_time 把状态落到两态之一（EXPIRED / ACTIVE；无满员上限） */
const REEVAL_SQL = `
  UPDATE pt_rides
  SET status = CASE
        WHEN end_time IS NOT NULL AND end_time < NOW() THEN 'EXPIRED'
        ELSE 'ACTIVE' END
  WHERE id = ?`;

/**
 * 编辑车次（管理端）：更新基础字段 + 重建分组（不涉及网关折扣表）。
 * - 不允许编辑已关闭（CLOSED）/已结束（EXPIRED）/已取消（CANCELLED）车次
 * - status 可选：表单里的上线/待上线开关；未传则已上线车次保持到期一致性（PENDING 不动）
 */
export async function updateRide(input: {
  rideId: number;
  name: string;
  description?: string;
  startTime?: Date | null;
  endTime?: Date | null;
  minCount: number;
  status?: "PENDING" | "ACTIVE";
  groups: RideGroupInput[];
  enrollType?: EnrollType;
}): Promise<void> {
  const { rideId, name, description, startTime, endTime, minCount, status, groups } = input;
  const enrollType: EnrollType = input.enrollType === "ADMIN_ONLY" ? "ADMIN_ONLY" : "PUBLIC";
  // 管理员拉人型：强制 min_count=1（成团不设门槛）
  const effectiveMinCount = enrollType === "ADMIN_ONLY" ? 1 : minCount;

  // —— 校验车次 ——
  const rides = await cpQuery("SELECT * FROM pt_rides WHERE id = ? LIMIT 1", [rideId]);
  const ride = Array.isArray(rides) && rides.length > 0 ? rides[0] : null;
  if (!ride) throw new RideError("RIDE_NOT_FOUND", "车次不存在");
  if (ride.status === "CLOSED") throw new RideError("RIDE_CLOSED", "车次已关闭，不可编辑");
  if (ride.status === "EXPIRED") throw new RideError("RIDE_EXPIRED", "车次已结束，不可编辑");
  if (ride.status === "CANCELLED") throw new RideError("RIDE_CANCELLED", "车次已取消，不可编辑");

  // —— 参数校验（与发车一致） ——
  if (!name || name.trim().length === 0) throw new RideError("INVALID_PARAMS", "车次名称必填");
  if (!Number.isInteger(minCount) || minCount < 1) {
    throw new RideError("INVALID_PARAMS", "最低成团人数至少 1 人");
  }
  validateTimeRange(startTime, endTime);
  validateGroups(groups);

  // —— 事务：更新车次 + 重建分组 + 上线/待上线开关 ——
  await cpTransaction(async (conn) => {
    await conn.execute(
      `UPDATE pt_rides
       SET name = ?, description = ?, min_count = ?, start_time = ?, end_time = ?, enroll_type = ?
       WHERE id = ?`,
      [name.trim(), description || null, effectiveMinCount, startTime || null, endTime || null, enrollType, rideId]
    );

    // 重建分组（先删后插）
    await conn.execute("DELETE FROM pt_ride_group_models WHERE ride_id = ?", [rideId]);
    await conn.execute("DELETE FROM pt_ride_groups WHERE ride_id = ?", [rideId]);

    let order = 0;
    for (const g of groups) {
      const [gr] = await conn.execute(
        "INSERT INTO pt_ride_groups (ride_id, discount_rate, display_order) VALUES (?, ?, ?)",
        [rideId, g.discountRate, order]
      );
      const groupId = Number((gr as any).insertId);
      for (const m of g.models) {
        await conn.execute(
          "INSERT INTO pt_ride_group_models (group_id, ride_id, model_id, model_name) VALUES (?, ?, ?, ?)",
          [groupId, rideId, m.modelId, m.modelName || m.modelId]
        );
      }
      order++;
    }

    // 上线/待上线开关：显式传才调整；未传则已上线车次按现状重估（PENDING 保持）
    if (status === "PENDING") {
      await conn.execute(
        "UPDATE pt_rides SET status = 'PENDING' WHERE id = ? AND status = 'ACTIVE'",
        [rideId]
      );
    } else if (status === "ACTIVE") {
      await conn.execute(
        `UPDATE pt_rides
         SET status = CASE
               WHEN end_time IS NOT NULL AND end_time < NOW() THEN 'EXPIRED'
               ELSE 'ACTIVE' END
         WHERE id = ? AND status = 'PENDING'`,
        [rideId]
      );
    } else {
      await conn.execute(REEVAL_SQL + " AND status = 'ACTIVE'", [rideId]);
    }

    // 成团补种：编辑后当前人数已达最低要求则锁存（一次性）
    await conn.execute(
      `UPDATE pt_rides SET established_at = COALESCE(established_at, NOW())
       WHERE id = ? AND established_at IS NULL AND current_count >= min_count`,
      [rideId]
    );
    // 管理员拉人型：无视人数，随时视为已成立（发车时间即折扣生效点）
    if (enrollType === "ADMIN_ONLY") {
      await conn.execute(
        `UPDATE pt_rides SET established_at = COALESCE(established_at, NOW()) WHERE id = ?`,
        [rideId]
      );
    }
  });
}

/**
 * 上线/待上线开关（管理端行级切换）
 *   PENDING→ACTIVE：按下线时的现状重估（过期→EXPIRED、否则 ACTIVE）
 *   ACTIVE→PENDING：置待上线（用户端不可见，不下发折扣改动）
 */
export async function setRideStatus(rideId: number, status: "PENDING" | "ACTIVE"): Promise<{ message: string }> {
  const rides = await cpQuery("SELECT id, status FROM pt_rides WHERE id = ? LIMIT 1", [rideId]);
  const ride = Array.isArray(rides) && rides.length > 0 ? rides[0] : null;
  if (!ride) throw new RideError("RIDE_NOT_FOUND", "车次不存在");

  if (status === "ACTIVE") {
    if (ride.status === "CLOSED" || ride.status === "EXPIRED" || ride.status === "CANCELLED") {
      throw new RideError("RIDE_CLOSED", "已关闭/已结束/已取消的车次不能上线");
    }
    if (ride.status === "PENDING") {
      const [ur] = await carpoolPool.execute(REEVAL_SQL, [rideId]);
      if ((ur as any).affectedRows === 0) return { message: "车次已上线" };
      const fresh = await cpQuery("SELECT status FROM pt_rides WHERE id = ?", [rideId]);
      const s = Array.isArray(fresh) && fresh.length > 0 ? fresh[0].status : null;
      if (s === "EXPIRED") return { message: "车次已结束，不能上线" };
      return { message: "车次已上线" };
    }
    return { message: "车次已上线" };
  }

  // 下线
  if (ride.status === "CLOSED" || ride.status === "EXPIRED" || ride.status === "CANCELLED") {
    throw new RideError("RIDE_CLOSED", "已关闭/已结束/已取消的车次不能下线");
  }
  await cpQuery("UPDATE pt_rides SET status = 'PENDING' WHERE id = ? AND status = 'ACTIVE'", [rideId]);
  return { message: "车次已下线" };
}

/**
 * 踢出成员（活跃度回收/人工干预）：置 KICKED + 释放名额
 */
export async function kickRideMember(rideId: number, ptUserId: number): Promise<{ ok: boolean; message: string }> {
  const members = await cpQuery("SELECT * FROM pt_ride_members WHERE ride_id = ? AND user_id = ? LIMIT 1", [rideId, ptUserId]);
  const member = Array.isArray(members) && members.length > 0 ? members[0] : null;
  if (!member || member.status !== "ACTIVE") return { ok: false, message: "该用户不在车上" };

  // 1. 成员置 KICKED
  await cpQuery("UPDATE pt_ride_members SET status = 'KICKED', kicked_at = NOW() WHERE id = ?", [member.id]);

  // 2. 名额 -1（无满员概念，状态不变）
  await cpQuery("UPDATE pt_rides SET current_count = GREATEST(current_count - 1, 0) WHERE id = ?", [rideId]);

  return { ok: true, message: "已请出该用户" };
}

/**
 * 管理员手动加人（幂等，镜像 joinRide 的成员写入模式）：
 *   - 允许在 ACTIVE / PENDING 车次上加人；已 CLOSED/EXPIRED/CANCELLED 拒绝
 *   - 新成员 INSERT IGNORE；KICKED 成员复活为 ACTIVE；已在车上的跳过
 *   - 名额 current_count 按实际新增数递增；达到 min_count 锁存 established_at
 * 返回 added（本次新增数）、skipped（已在车上）、unknown（不存在的 userId）
 */
export async function addRideMembers(
  rideId: number,
  userIds: number[]
): Promise<{ added: number; skipped: number[]; unknown: number[] }> {
  const clean = [...new Set(userIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (clean.length === 0) throw new RideError("INVALID_PARAMS", "请至少选择一个用户");

  // 1. 校验车次
  const rides = await cpQuery("SELECT * FROM pt_rides WHERE id = ? LIMIT 1", [rideId]);
  const ride = Array.isArray(rides) ? rides[0] : null;
  if (!ride) throw new RideError("RIDE_NOT_FOUND", "车次不存在");
  if (["CLOSED", "EXPIRED", "CANCELLED"].includes(ride.status)) {
    throw new RideError("RIDE_CLOSED", "车次已关闭/已结束/已取消，不可添加成员");
  }

  // 2. 校验用户存在（过滤未知 userId）
  const placeholders = clean.map(() => "?").join(",");
  const userRows = await cpQuery(`SELECT id FROM pt_users WHERE id IN (${placeholders})`, clean);
  const knownIds = new Set((Array.isArray(userRows) ? userRows : []).map((u: any) => Number(u.id)));
  const unknown = clean.filter((id) => !knownIds.has(id));
  const validIds = clean.filter((id) => knownIds.has(id));

  // 3. 逐个写入（INSERT IGNORE 判重 + KICKED 复活，与 joinRide 一致）
  let added = 0;
  const skipped: number[] = [];
  for (const uid of validIds) {
    const r = await cpQuery("INSERT IGNORE INTO pt_ride_members (ride_id, user_id) VALUES (?, ?)", [rideId, uid]);
    const affected = Number((r as any).affectedRows || 0);
    if (affected === 0) {
      // 已存在记录：仅 KICKED 可复活为 ACTIVE，否则视为已在车上
      const ms = await cpQuery(
        "SELECT status FROM pt_ride_members WHERE ride_id = ? AND user_id = ? LIMIT 1",
        [rideId, uid]
      );
      const m = Array.isArray(ms) && ms.length > 0 ? ms[0] : null;
      if (m && m.status === "KICKED") {
        await cpQuery(
          "UPDATE pt_ride_members SET status = 'ACTIVE', kicked_at = NULL WHERE ride_id = ? AND user_id = ?",
          [rideId, uid]
        );
        added++;
      } else {
        skipped.push(uid);
      }
    } else {
      added++;
    }
  }

  // 4. 名额递增 + 成团锁存（一次性）
  if (added > 0) {
    await cpQuery("UPDATE pt_rides SET current_count = current_count + ? WHERE id = ?", [added, rideId]);
    await cpQuery(
      `UPDATE pt_rides SET established_at = COALESCE(established_at, NOW())
       WHERE id = ? AND established_at IS NULL AND current_count >= min_count`,
      [rideId]
    );
  }

  return { added, skipped, unknown };
}

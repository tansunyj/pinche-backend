import bcrypt from "bcryptjs";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import pool from "../db/mysql";

/**
 * 与 user_users 表对应的行类型（驼峰命名向 JS 暴露，DB 字段保持下划线）
 */
export interface UserRow {
  id: number;
  email: string | null;
  phone: string | null;
  name: string | null;
  password_hash: string | null;
  avatar: string | null;
  provider: "email" | "wechat" | "alipay";
  provider_id: string | null;
  email_verified_at: Date | null;
  user_type: number; // 1=普通/2=管理员/3=超管
  status: number; // 0=封禁/1=正常/2=欠费冻结
  balance: number;
  cumulative_recharge: number;
  overdraft_since: Date | null;
  tier_id: number;
  tier_locked: number;
  invited_by: number | null;
  last_login_at: Date | null;
  last_login_ip: string | null;
  login_fail_count: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/**
 * 暴露给前端的公开字段（脱敏）
 */
export function getPublicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    avatar: user.avatar,
    provider: user.provider,
    emailVerified: !!user.email_verified_at,
    userType: user.user_type,
    status: user.status,
    balance: Number(user.balance),
    tierId: user.tier_id,
    createdAt: user.created_at,
  };
}

const SELECT_USER_COLUMNS = `
  id, email, phone, name, password_hash, avatar,
  provider, provider_id, email_verified_at,
  user_type, status,
  balance, cumulative_recharge, overdraft_since,
  tier_id, tier_locked,
  invited_by,
  last_login_at, last_login_ip, login_fail_count, locked_until,
  created_at, updated_at, deleted_at
`;

const ACCOUNT_LOCK_THRESHOLD = 5; // 连续失败 N 次后锁定
const ACCOUNT_LOCK_MINUTES = 15;

class UserService {
  // ============ 查询 ============

  async findById(id: number): Promise<UserRow | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_USER_COLUMNS} FROM user_users
        WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    return (rows[0] as UserRow) || null;
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_USER_COLUMNS} FROM user_users
        WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
      [email]
    );
    return (rows[0] as UserRow) || null;
  }

  async findByPhone(phone: string): Promise<UserRow | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_USER_COLUMNS} FROM user_users
        WHERE phone = ? AND deleted_at IS NULL LIMIT 1`,
      [phone]
    );
    return (rows[0] as UserRow) || null;
  }

  async findByProvider(
    provider: "wechat" | "alipay",
    providerId: string
  ): Promise<UserRow | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_USER_COLUMNS} FROM user_users
        WHERE provider = ? AND provider_id = ? AND deleted_at IS NULL LIMIT 1`,
      [provider, providerId]
    );
    return (rows[0] as UserRow) || null;
  }

  // ============ 注册 ============

  /**
   * 邮箱注册：只创建 user_users 行
   * （不自动创建任何 token，用户按需自己在 Profile 创建）
   */
  async createEmailUser(input: {
    email: string;
    name?: string | null;
    password: string; // 明文，内部 bcrypt
    invitedBy?: number | null;
  }): Promise<{ userId: number }> {
    const passwordHash = await bcrypt.hash(input.password, 10);
    const [userResult] = await pool.execute<ResultSetHeader>(
      `INSERT INTO user_users
        (email, name, password_hash, provider, user_type, status, invited_by)
       VALUES (?, ?, ?, 'email', 1, 1, ?)`,
      [input.email, input.name ?? null, passwordHash, input.invitedBy ?? null]
    );
    return { userId: userResult.insertId };
  }

  // ============ 更新 ============

  async updatePassword(userId: number, newPassword: string): Promise<void> {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.execute(
      `UPDATE user_users SET password_hash = ? WHERE id = ?`,
      [hash, userId]
    );
  }

  async updateProfile(
    userId: number,
    fields: { name?: string; avatar?: string }
  ): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];
    if (fields.name !== undefined) {
      sets.push("name = ?");
      values.push(fields.name);
    }
    if (fields.avatar !== undefined) {
      sets.push("avatar = ?");
      values.push(fields.avatar);
    }
    if (sets.length === 0) return;
    values.push(userId);
    await pool.execute(
      `UPDATE user_users SET ${sets.join(", ")} WHERE id = ?`,
      values
    );
  }

  async setEmailVerified(userId: number): Promise<void> {
    await pool.execute(
      `UPDATE user_users SET email_verified_at = NOW() WHERE id = ?`,
      [userId]
    );
  }

  async bindPhone(userId: number, phone: string): Promise<void> {
    await pool.execute(
      `UPDATE user_users SET phone = ? WHERE id = ?`,
      [phone, userId]
    );
  }

  async unbindPhone(userId: number): Promise<void> {
    await pool.execute(
      `UPDATE user_users SET phone = NULL WHERE id = ?`,
      [userId]
    );
  }

  /**
   * 第三方扫码登录：首次扫码时自动建用户。
   *   - email / password_hash / phone 都留 NULL
   *   - provider 标记来源（wechat/alipay）
   *   - provider_id 必须唯一（DB 上 (provider, provider_id) 应有联合唯一约束）
   */
  async createOAuthUser(input: {
    provider: "wechat" | "alipay";
    providerId: string;
    name?: string | null;
    avatar?: string | null;
  }): Promise<{ userId: number }> {
    const [r] = await pool.execute<ResultSetHeader>(
      `INSERT INTO user_users
        (name, avatar, provider, provider_id, user_type, status)
       VALUES (?, ?, ?, ?, 1, 1)`,
      [input.name ?? null, input.avatar ?? null, input.provider, input.providerId]
    );
    return { userId: r.insertId };
  }

  /**
   * 手机号注册：首次手机号登录时自动建用户。
   *   - email / password_hash 都留 NULL
   *   - provider 设为 'phone' 便于区分来源
   */
  async createPhoneUser(input: {
    phone: string;
    name?: string | null;
    invitedBy?: number | null;
  }): Promise<{ userId: number }> {
    const [r] = await pool.execute<ResultSetHeader>(
      `INSERT INTO user_users
        (phone, name, provider, user_type, status, invited_by)
       VALUES (?, ?, 'phone', 1, 1, ?)`,
      [input.phone, input.name ?? null, input.invitedBy ?? null]
    );
    return { userId: r.insertId };
  }

  // ============ 登录安全 ============

  /**
   * 校验密码并自动维护登录失败计数 / 账号锁定
   * @returns null 表示账号锁定；UserRow 表示密码正确；false 表示密码错误
   */
  async verifyPassword(
    user: UserRow,
    password: string
  ): Promise<"locked" | "wrong" | "ok"> {
    // 锁定中
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return "locked";
    }
    if (!user.password_hash) {
      return "wrong";
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      const next = user.login_fail_count + 1;
      const shouldLock = next >= ACCOUNT_LOCK_THRESHOLD;
      await pool.execute(
        `UPDATE user_users
            SET login_fail_count = ?,
                locked_until = ?
          WHERE id = ?`,
        [
          next,
          shouldLock
            ? new Date(Date.now() + ACCOUNT_LOCK_MINUTES * 60 * 1000)
            : user.locked_until,
          user.id,
        ]
      );
      return "wrong";
    }
    return "ok";
  }

  async markLoginSuccess(userId: number, ip: string | null): Promise<void> {
    await pool.execute(
      `UPDATE user_users
          SET last_login_at = NOW(),
              last_login_ip = ?,
              login_fail_count = 0,
              locked_until = NULL
        WHERE id = ?`,
      [ip, userId]
    );
  }
}

export default new UserService();

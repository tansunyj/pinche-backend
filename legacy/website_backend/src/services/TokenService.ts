import crypto from "crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import pool from "../db/mysql";
import StatsService from "./StatsService";

export interface ProxyTokenRow {
  id: number;
  user_id: number;
  name: string | null;
  key: string;
  models: string | null;
  quota: number;
  used_quota: number;
  price_markup: string | number;
  gift_quota: number; // 赠送额度
  expired_at: Date | null;
  start_at: Date | null;
  status: number;
  created_at: Date;
}

const SELECT_TOKEN_COLUMNS = `
  id, user_id, name, \`key\`,
  models, quota, used_quota, price_markup, gift_quota,
  expired_at, start_at, status, created_at
`;

/**
 * 把完整 key 脱敏：保留前缀（sk-silievo- / sk-）+ 8 个 • + 末 4 位
 *   sk-silievo-a852dcbd78294337b54466e83ff55c6f  →  sk-silievo-••••••••55c6f
 *   sk-abcdef...                                →  sk-••••••••cdef
 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return key.replace(/.(?=.{2})/g, "•");

  const knownPrefixes = ["sk-silievo-", "sk-"];
  const prefix = knownPrefixes.find((p) => key.startsWith(p)) ?? key.slice(0, 3);
  const tail = key.slice(-4);
  return `${prefix}${"•".repeat(8)}${tail}`;
}

/**
 * 暴露给前端的 token 字段（不含明文 key，仅返回必要字段避免泄密）
 */
export function getPublicToken(row: ProxyTokenRow) {
  const now = new Date();
  const expired = row.expired_at ? new Date(row.expired_at) < now : false;
  const notStarted = row.start_at ? new Date(row.start_at) > now : false;
  const isExpired = expired || notStarted || row.status !== 1;

  return {
    id: row.id,
    name: row.name,
    key: isExpired ? '******（已失效）' : maskKey(row.key),
    status: isExpired ? 0 : row.status,  // 统一用 0 表示失效
    start_at: row.start_at ?? null,
    expired_at: row.expired_at ?? null,
    is_expired: isExpired,
    price_markup: Number(row.price_markup) || 1, // 价格折扣，默认1（无折扣）
  };
}

class TokenService {
  /**
   * 列出指定用户的全部 token
   */
  async listByUser(userId: number): Promise<ProxyTokenRow[]> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT proxy_tokens.id, proxy_tokens.user_id, proxy_tokens.name, proxy_tokens.\`key\`,
              proxy_tokens.models, proxy_tokens.quota, proxy_tokens.used_quota, proxy_tokens.price_markup,
              proxy_tokens.gift_quota,
              proxy_tokens.expired_at, proxy_tokens.start_at, proxy_tokens.status, proxy_tokens.created_at,
              uc.id AS coupon_id,
              p.name AS coupon_name,
              p.end_at AS promotion_end_at
       FROM proxy_tokens
       LEFT JOIN user_coupons uc ON uc.token_id = proxy_tokens.id AND uc.status = 'bound'
       LEFT JOIN promotions p ON p.id = uc.promotion_id
       WHERE proxy_tokens.user_id = ?
       ORDER BY proxy_tokens.created_at DESC`,
      [userId]
    );
    return rows as ProxyTokenRow[];
  }

  async findById(id: number, userId: number): Promise<ProxyTokenRow | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_TOKEN_COLUMNS} FROM proxy_tokens
        WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId]
    );
    return (rows[0] as ProxyTokenRow) || null;
  }

  /**
   * 通过 key 查找 token（用于 API Key 鉴权）
   */
  async findByKey(key: string): Promise<ProxyTokenRow | null> {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_TOKEN_COLUMNS} FROM proxy_tokens
        WHERE \`key\` = ? LIMIT 1`,
      [key]
    );
    return (rows[0] as ProxyTokenRow) || null;
  }

  /**
   * 创建用户级 token：sk-silievo-{32 hex}
   * 创建时从用户余额扣除额度
   *
   * 注意：单位统一后，quota 和 balance 都是"点数"单位（1元=100000）
   * 不再需要进行 /1000 转换
   */
  async create(input: {
    userId: number;
    name: string;
    expiredAt?: Date | null;
    startAt?: Date | null;
  }): Promise<ProxyTokenRow> {
    // 获取数据库连接以支持事务
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 创建 Token（quota 设为 0，不再扣除用户余额）
      const key = `sk-silievo-${crypto.randomBytes(16).toString("hex")}`;
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO proxy_tokens (user_id, name, \`key\`, quota, remain_quota, rate_limit_rpm, status, expired_at, start_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [input.userId, input.name.trim(), key, 0, 0, 10000, input.expiredAt ?? null, input.startAt ?? null]
      );

      await connection.commit();

      // 重新获取Token信息（使用普通连接）
      const row = await this.findById(result.insertId, input.userId);
      if (!row) throw new Error("Token created but not found");

      // 记录Token创建统计
      StatsService.recordTokenCreated(row.id, input.userId);

      return row;
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * 删除用户级 token，退还 remain_quota 到用户余额并记录日志
   * 注意：绑定了优惠券的 token 不允许删除，因此允许删除的 token 都没有 gift_quota
   *
   * 单位统一后：remain_quota 和 balance 都是"点数"单位（1元=100000），不再除以 1000
   */
  async delete(id: number, userId: number): Promise<{ success: boolean; error?: string }> {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 1. 检查 token 是否绑定了优惠券
      const [boundCoupons] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM user_coupons WHERE token_id = ? AND status = 'bound' LIMIT 1`,
        [id]
      );
      if ((boundCoupons as any[]).length > 0) {
        await connection.rollback();
        return { success: false, error: "该 API Key 已绑定优惠券，无法删除" };
      }

      // 2. 锁定并读取 token（FOR UPDATE 防并发）
      const [tokenRows] = await connection.execute<RowDataPacket[]>(
        `SELECT id, name, quota, remain_quota, gift_quota FROM proxy_tokens WHERE id = ? AND user_id = ? FOR UPDATE`,
        [id, userId]
      );
      if (tokenRows.length === 0) {
        await connection.rollback();
        return { success: false, error: "Token 不存在" };
      }

      const token = tokenRows[0];
      const remainQuota = Number(token.remain_quota ?? 0);
      // 单位统一后：remain_quota 和 balance 都是点数单位（1元=100000），直接返还
      const refundPoints = Math.max(0, remainQuota);

      console.log(`[Token Delete] token=${id}, remain_quota=${remainQuota}, refund_points=${refundPoints}`);

      // 3. 删除 token
      const [result] = await connection.execute<ResultSetHeader>(
        `DELETE FROM proxy_tokens WHERE id = ? AND user_id = ?`,
        [id, userId]
      );
      if (result.affectedRows === 0) {
        await connection.rollback();
        return { success: false, error: "删除失败" };
      }

      // 4. 退还余额（仅当有剩余额度时）
      if (refundPoints > 0) {
        await connection.execute(
          `UPDATE user_users SET balance = balance + ? WHERE id = ?`,
          [refundPoints, userId]
        );
      }

      // 5. 记录到 proxy_request_logs
      const requestId = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO proxy_request_logs
          (request_id, user_id, token_id, model, request_method, request_path, response_status, cost_points, created_at, completed_at)
         VALUES (?, ?, ?, 'system', 'DELETE', '/tokens', 200, ?, NOW(), NOW())`,
        [requestId, userId, id, -refundPoints]
      );

      await connection.commit();
      return { success: true };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * 改名
   */
  async rename(id: number, userId: number, name: string): Promise<boolean> {
    const [result] = await pool.execute<ResultSetHeader>(
      `UPDATE proxy_tokens SET name = ? WHERE id = ? AND user_id = ?`,
      [name.trim(), id, userId]
    );
    return result.affectedRows > 0;
  }

  /**
   * 切换启用 / 禁用
   */
  async setStatus(id: number, userId: number, enabled: boolean): Promise<boolean> {
    const [result] = await pool.execute<ResultSetHeader>(
      `UPDATE proxy_tokens SET status = ? WHERE id = ? AND user_id = ?`,
      [enabled ? 1 : 0, id, userId]
    );
    return result.affectedRows > 0;
  }
}

export default new TokenService();

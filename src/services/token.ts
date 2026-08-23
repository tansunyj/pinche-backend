/**
 * API Key 服务：直连网关库 proxy_tokens 表（融合自老 TokenService.ts）
 * 剔除优惠券/统计依赖；额度/余额口径为"点数"（1元=100000）。
 */

import crypto from "crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { gatewayPool } from "../config/db";

export interface ProxyTokenRow {
  id: number;
  user_id: number;
  name: string | null;
  key: string;
  models: string | null;
  quota: number;
  used_quota: number;
  price_markup: string | number;
  expired_at: Date | null;
  start_at: Date | null;
  status: number;
  created_at: Date;
}

const SELECT_TOKEN_COLUMNS = `
  id, user_id, name, \`key\`,
  models, quota, used_quota, price_markup,
  expired_at, start_at, status, created_at
`;

/** 脱敏：sk-silievo-••••••••55c6f */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return key.replace(/.(?=.{2})/g, "•");
  const knownPrefixes = ["sk-silievo-", "sk-"];
  const prefix = knownPrefixes.find((p) => key.startsWith(p)) ?? key.slice(0, 3);
  return `${prefix}${"•".repeat(8)}${key.slice(-4)}`;
}

export function getPublicToken(row: ProxyTokenRow) {
  const now = new Date();
  const expired = row.expired_at ? new Date(row.expired_at) < now : false;
  const notStarted = row.start_at ? new Date(row.start_at) > now : false;
  const isExpired = expired || notStarted;
  return {
    id: row.id,
    name: row.name,
    key: isExpired ? "******（已失效）" : maskKey(row.key),
    status: isExpired ? 0 : row.status,
    start_at: row.start_at ?? null,
    expired_at: row.expired_at ?? null,
    is_expired: isExpired,
    price_markup: Number(row.price_markup) || 1,
  };
}

class TokenService {
  async listByUser(userId: number): Promise<ProxyTokenRow[]> {
    const [rows] = await gatewayPool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_TOKEN_COLUMNS} FROM proxy_tokens
       WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    return rows as ProxyTokenRow[];
  }

  async findById(id: number, userId: number): Promise<ProxyTokenRow | null> {
    const [rows] = await gatewayPool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_TOKEN_COLUMNS} FROM proxy_tokens WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId]
    );
    return (rows[0] as ProxyTokenRow) || null;
  }

  async findByKey(key: string): Promise<ProxyTokenRow | null> {
    const [rows] = await gatewayPool.execute<RowDataPacket[]>(
      `SELECT ${SELECT_TOKEN_COLUMNS} FROM proxy_tokens WHERE \`key\` = ? LIMIT 1`,
      [key]
    );
    return (rows[0] as ProxyTokenRow) || null;
  }

  /** 创建用户级 token（额度走余额，quota=0 不预扣） */
  async create(input: { userId: number; name: string; expiredAt?: Date | null }): Promise<ProxyTokenRow> {
    const key = `sk-silievo-${crypto.randomBytes(16).toString("hex")}`;
    const [result] = await gatewayPool.execute<ResultSetHeader>(
      `INSERT INTO proxy_tokens (user_id, name, \`key\`, quota, remain_quota, rate_limit_rpm, status, expired_at, start_at)
       VALUES (?, ?, ?, 0, 0, 10000, 1, ?, ?)`,
      [input.userId, input.name.trim(), key, input.expiredAt ?? null, null]
    );
    const row = await this.findById(result.insertId, input.userId);
    if (!row) throw new Error("Token created but not found");
    return row;
  }

  /** 删除 Key：不返还剩余额度（用户明确要求），仅删除记录 */
  async delete(id: number, userId: number): Promise<{ success: boolean; error?: string }> {
    const [result] = await gatewayPool.execute<ResultSetHeader>(
      `DELETE FROM proxy_tokens WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    if (result.affectedRows === 0) {
      return { success: false, error: "Token 不存在" };
    }
    return { success: true };
  }

  async rename(id: number, userId: number, name: string): Promise<boolean> {
    const [result] = await gatewayPool.execute<ResultSetHeader>(
      `UPDATE proxy_tokens SET name = ? WHERE id = ? AND user_id = ?`,
      [name.trim(), id, userId]
    );
    return result.affectedRows > 0;
  }

  async setStatus(id: number, userId: number, enabled: boolean): Promise<boolean> {
    const [result] = await gatewayPool.execute<ResultSetHeader>(
      `UPDATE proxy_tokens SET status = ? WHERE id = ? AND user_id = ?`,
      [enabled ? 1 : 0, id, userId]
    );
    return result.affectedRows > 0;
  }
}

export default new TokenService();

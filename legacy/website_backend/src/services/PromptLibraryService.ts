/**
 * 提示词收藏夹服务
 *
 * 设计要点：
 *   - 用 content_hash (SHA-256) 配合 uk_user_hash 做"同一用户重复收藏自动累加 use_count"
 *   - 不存储敏感词，content 字段 TEXT，无前缀索引
 */

import crypto from "crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../db/mysql";

export interface PromptRow extends RowDataPacket {
  id: number;
  user_id: number;
  content: string;
  content_hash: string;
  name: string | null;
  tags: unknown;
  source_job_id: number | null;
  use_count: number;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PromptDTO {
  id: number;
  content: string;
  name: string | null;
  tags: string[];
  source_job_id: number | null;
  use_count: number;
  last_used_at: Date | null;
  created_at: Date;
}

function hashContent(s: string): string {
  return crypto.createHash("sha256").update(s.trim()).digest("hex");
}

function parseTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch { return []; }
  }
  return [];
}

function toDTO(r: PromptRow): PromptDTO {
  return {
    id: r.id,
    content: r.content,
    name: r.name,
    tags: parseTags(r.tags),
    source_job_id: r.source_job_id,
    use_count: r.use_count,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
  };
}

class PromptLibraryService {
  /**
   * 收藏一条提示词（UPSERT 语义）
   *   - 同一用户 + 同 content 已存在 → 累加 use_count，更新 last_used_at
   *   - 不存在 → 新建
   */
  async favorite(input: {
    userId: number;
    content: string;
    name?: string | null;
    tags?: string[] | null;
    sourceJobId?: number | null;
  }): Promise<PromptDTO> {
    const content = input.content.trim();
    if (!content) throw new Error("提示词不能为空");
    if (content.length > 4000) throw new Error("提示词长度超过 4000 字");

    const hash = hashContent(content);
    const tagsJson = input.tags ? JSON.stringify(input.tags) : null;

    // 用 ON DUPLICATE KEY UPDATE 做 upsert
    await pool.execute<ResultSetHeader>(
      `INSERT INTO prompt_library
        (user_id, content, content_hash, name, tags, source_job_id, use_count, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE
         use_count = use_count + 1,
         last_used_at = NOW(),
         name = COALESCE(VALUES(name), name),
         tags = COALESCE(VALUES(tags), tags)`,
      [
        input.userId,
        content,
        hash,
        input.name ?? null,
        tagsJson,
        input.sourceJobId ?? null,
      ]
    );

    const [rows] = await pool.execute<PromptRow[]>(
      `SELECT * FROM prompt_library WHERE user_id = ? AND content_hash = ? LIMIT 1`,
      [input.userId, hash]
    );
    const r = rows[0];
    if (!r) throw new Error("favorite: upsert 后查询失败");
    return toDTO(r);
  }

  async unfavorite(id: number, userId: number): Promise<boolean> {
    const [r] = await pool.execute<ResultSetHeader>(
      `DELETE FROM prompt_library WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    return r.affectedRows > 0;
  }

  async updateMeta(
    id: number,
    userId: number,
    patch: { name?: string | null; tags?: string[] | null }
  ): Promise<PromptDTO | null> {
    const sets: string[] = [];
    const params: any[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.tags !== undefined) {
      sets.push("tags = ?");
      params.push(patch.tags === null ? null : JSON.stringify(patch.tags));
    }
    if (sets.length === 0) return this.findById(id, userId);
    params.push(id, userId);
    await pool.execute(
      `UPDATE prompt_library SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
      params
    );
    return this.findById(id, userId);
  }

  /** 一键复用：累加 use_count + 刷新 last_used_at（不返回内容，前端已有） */
  async incrementUseCount(id: number, userId: number): Promise<void> {
    await pool.execute(
      `UPDATE prompt_library
          SET use_count = use_count + 1, last_used_at = NOW()
        WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
  }

  async findById(id: number, userId: number): Promise<PromptDTO | null> {
    const [rows] = await pool.execute<PromptRow[]>(
      `SELECT * FROM prompt_library WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId]
    );
    return rows[0] ? toDTO(rows[0]) : null;
  }

  /** 列表（按 sort: recent | hot） */
  async listUserPrompts(opts: {
    userId: number;
    sort?: "recent" | "hot";
    keyword?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: PromptDTO[]; total: number }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    const offset = Math.max(0, opts.offset ?? 0);
    const conds = ["user_id = ?"];
    const params: any[] = [opts.userId];
    if (opts.keyword && opts.keyword.trim()) {
      conds.push("(content LIKE ? OR name LIKE ?)");
      const like = `%${opts.keyword.trim()}%`;
      params.push(like, like);
    }
    const where = conds.join(" AND ");
    const orderBy =
      opts.sort === "hot"
        ? "use_count DESC, last_used_at DESC, created_at DESC"
        : "created_at DESC";

    const [[countRow]] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM prompt_library WHERE ${where}`,
      params
    );
    const total = Number((countRow as any).c) || 0;

    const [rows] = await pool.execute<PromptRow[]>(
      `SELECT * FROM prompt_library
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return { items: rows.map(toDTO), total };
  }
}

export default new PromptLibraryService();

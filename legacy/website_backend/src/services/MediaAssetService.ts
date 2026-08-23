/**
 * 媒体资产服务
 *
 * 负责：
 *   - 创建/查询/列举/软删 media_assets 行
 *   - 不负责文件本体上传（那是 OssService 的事），但提供"上传 + 入库"的一站式 helper
 *   - 不负责扣点（那是 MediaJobService 的事）
 */

import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../db/mysql";
import OssService from "./storage/OssService";

export type AssetType = "image" | "video";
export type AssetSource = "generated" | "uploaded";

export interface MediaAssetRow extends RowDataPacket {
  id: number;
  user_id: number;
  type: AssetType;
  source: AssetSource;
  oss_key: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  thumbnail_oss_key: string | null;
  related_job_id: number | null;
  name: string | null;
  tags: unknown;
  is_favorite: number;
  is_deleted: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MediaAssetDTO {
  id: number;
  type: AssetType;
  source: AssetSource;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  related_job_id: number | null;
  name: string | null;
  tags: string[];
  is_favorite: boolean;
  created_at: Date;
  /** 签名 URL（已生成，前端直接展示） */
  url: string;
  thumbnail_url: string | null;
  /** 生成时的提示词（来自关联的 job） */
  prompt: string | null;
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

export interface CreateAssetInput {
  userId: number;
  type: AssetType;
  source: AssetSource;
  ossKey: string;
  mime: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  thumbnailOssKey?: string | null;
  relatedJobId?: number | null;
}

class MediaAssetService {
  /** 仅入库，文件已传到 OSS */
  async createAsset(input: CreateAssetInput, conn?: PoolConnection): Promise<number> {
    const exec = conn ?? pool;
    const [r] = await exec.execute<ResultSetHeader>(
      `INSERT INTO media_assets
        (user_id, type, source, oss_key, mime, size_bytes,
         width, height, duration_ms, thumbnail_oss_key, related_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.userId,
        input.type,
        input.source,
        input.ossKey,
        input.mime,
        input.sizeBytes,
        input.width ?? null,
        input.height ?? null,
        input.durationMs ?? null,
        input.thumbnailOssKey ?? null,
        input.relatedJobId ?? null,
      ]
    );
    return r.insertId;
  }

  /** 一站式：上传 Buffer + 入库 */
  async uploadAndCreate(input: {
    userId: number;
    type: AssetType;
    source: AssetSource;
    body: Buffer;
    mime: string;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    relatedJobId?: number | null;
  }): Promise<MediaAssetDTO> {
    const ossKey = OssService.buildKey({
      userId: input.userId,
      kind: input.type === "video" ? "video" : input.source === "uploaded" ? "upload" : "image",
      mime: input.mime,
    });
    const put = await OssService.putObject({
      ossKey,
      body: input.body,
      mime: input.mime,
    });
    const id = await this.createAsset({
      userId: input.userId,
      type: input.type,
      source: input.source,
      ossKey: put.ossKey,
      mime: put.mime,
      sizeBytes: put.size,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
      relatedJobId: input.relatedJobId ?? null,
    });
    const dto = await this.findById(id, input.userId);
    if (!dto) throw new Error("uploadAndCreate: 入库后查询失败");
    return dto;
  }

  async findById(id: number, userId: number): Promise<MediaAssetDTO | null> {
    const [rows] = await pool.execute<MediaAssetRow[]>(
      `SELECT * FROM media_assets
        WHERE id = ? AND user_id = ? AND is_deleted = 0
        LIMIT 1`,
      [id, userId]
    );
    const r = rows[0];
    return r ? await this.toDTO(r) : null;
  }

  /** 内部用：按 id 取（不限 user_id，给 poller 等系统组件用） */
  async findByIdSystem(id: number): Promise<MediaAssetRow | null> {
    const [rows] = await pool.execute<MediaAssetRow[]>(
      `SELECT * FROM media_assets WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  }

  /** 画廊列表（支持类型/收藏/分页筛选） */
  async listUserAssets(opts: {
    userId: number;
    type?: AssetType;
    favoriteOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ items: MediaAssetDTO[]; total: number }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    const offset = Math.max(0, opts.offset ?? 0);

    const conds = ["ma.user_id = ?", "ma.is_deleted = 0", "ma.source = 'generated'"];
    const params: any[] = [opts.userId];
    if (opts.type) {
      conds.push("ma.type = ?");
      params.push(opts.type);
    }
    if (opts.favoriteOnly) {
      conds.push("ma.is_favorite = 1");
    }

    const where = conds.join(" AND ");

    const [[countRow]] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM media_assets ma WHERE ${where}`,
      params
    );
    const total = Number((countRow as any).c) || 0;

    // 查询资产并 JOIN media_jobs 获取提示词
    const [rows] = await pool.execute<(MediaAssetRow & RowDataPacket & { prompt?: string })[]>(
      `SELECT ma.*, mj.prompt
         FROM media_assets ma
         LEFT JOIN media_jobs mj ON ma.related_job_id = mj.id
        WHERE ${where}
        ORDER BY ma.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const items = await Promise.all(rows.map((r) => this.toDTO(r, r.prompt)));
    return { items, total };
  }

  /** 更新名字/标签/收藏 */
  async updateMeta(
    id: number,
    userId: number,
    patch: { name?: string | null; tags?: string[] | null; isFavorite?: boolean }
  ): Promise<MediaAssetDTO | null> {
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
    if (patch.isFavorite !== undefined) {
      sets.push("is_favorite = ?");
      params.push(patch.isFavorite ? 1 : 0);
    }
    if (sets.length === 0) return this.findById(id, userId);

    params.push(id, userId);
    await pool.execute(
      `UPDATE media_assets
          SET ${sets.join(", ")}
        WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      params
    );
    return this.findById(id, userId);
  }

  /** 软删（批量） */
  async softDelete(ids: number[], userId: number): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const [r] = await pool.execute<ResultSetHeader>(
      `UPDATE media_assets
          SET is_deleted = 1, deleted_at = NOW()
        WHERE id IN (${placeholders}) AND user_id = ? AND is_deleted = 0`,
      [...ids, userId]
    );
    return r.affectedRows;
  }

  /** 转 DTO（含签名 URL） */
  async toDTO(r: MediaAssetRow, promptOverride?: string): Promise<MediaAssetDTO> {
    const [url, thumb] = await Promise.all([
      OssService.getSignedUrl(r.oss_key),
      r.thumbnail_oss_key ? OssService.getSignedUrl(r.thumbnail_oss_key) : Promise.resolve(null),
    ]);
    return {
      id: r.id,
      type: r.type,
      source: r.source,
      mime: r.mime,
      size_bytes: Number(r.size_bytes),
      width: r.width,
      height: r.height,
      duration_ms: r.duration_ms,
      related_job_id: r.related_job_id,
      name: r.name,
      tags: parseTags(r.tags),
      is_favorite: !!r.is_favorite,
      created_at: r.created_at,
      url,
      thumbnail_url: thumb,
      prompt: promptOverride ?? null,
    };
  }
}

export default new MediaAssetService();

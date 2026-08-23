/**
 * OSS 存储服务
 *
 * 两种模式：
 *   1. 生产模式：阿里云 OSS（凭 OSS_ACCESS_KEY_ID / OSS_BUCKET 等环境变量）
 *   2. dry-run 模式（STORAGE_DRY_RUN=true 或未配置凭证时自动降级）：
 *      - 文件落到 ./tmp/oss-mock/{oss_key}
 *      - 签名 URL 形如 http://localhost:13001/mock-oss/{oss_key}?expires=...
 *      - 由 backend index.ts 挂一个 /mock-oss/* 静态路由提供下载
 *
 * 提供能力：
 *   - putObject：上传 Buffer / Stream
 *   - putFromRemoteUrl：从第三方临时 URL 拉文件直传到 OSS（供 poller 用）
 *   - getSignedUrl：生成临时下载/查看链接（默认 1 小时）
 *   - deleteObject：物理删除
 *   - buildKey：按用户/类型/uuid 生成 oss_key
 *
 * 注意：本服务只管"文件存储"，不管 DB；DB 记录由 MediaAssetService 负责
 */

import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

// ============== 配置 ==============

function isDryRun(): boolean {
  if (process.env.STORAGE_DRY_RUN === "true" || process.env.STORAGE_DRY_RUN === "1") return true;
  // 没配凭证也自动 dry-run，避免本地启动炸
  if (!process.env.OSS_ACCESS_KEY_ID || !process.env.OSS_BUCKET) return true;
  return false;
}

const MOCK_ROOT = path.resolve(process.cwd(), "tmp/oss-mock");
const MOCK_URL_PREFIX = process.env.MOCK_OSS_URL_PREFIX || "http://localhost:13001/mock-oss";

const SIGN_TTL_SECONDS = Number(process.env.OSS_SIGN_TTL || 3600);

// ============== 类型 ==============

export type AssetKind = "image" | "video" | "thumbnail" | "upload" | "audio" | "video-input";

export interface PutObjectInput {
  ossKey: string;
  body: Buffer | Readable;
  mime: string;
  size?: number;
}

export interface PutObjectResult {
  ossKey: string;
  size: number;
  mime: string;
}

// ============== OSS 客户端（懒加载，避免 dry-run 时强依赖 SDK） ==============

let _ossClient: any | null = null;
async function getOssClient() {
  if (_ossClient) return _ossClient;
  // 动态 require，未安装时只在生产模式抛错（dry-run 不依赖此 SDK）
  // 用 eval('require') 绕开 TS / esbuild 的静态依赖分析
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
  const dynamicRequire = eval("require") as NodeJS.Require;
  const OSS = dynamicRequire("ali-oss");
  _ossClient = new OSS({
    region: process.env.OSS_REGION || "oss-cn-hangzhou",
    accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
    bucket: process.env.OSS_BUCKET!,
    internal: process.env.OSS_INTERNAL === "true",
    secure: true,
    // 增加超时配置，适应大文件上传
    timeout: Number(process.env.OSS_TIMEOUT || 120000), // 120秒
    // 分块上传配置
    partSize: 1024 * 1024, // 1MB 每块
    maxConcurrency: 5, // 并发上传数
  });
  return _ossClient;
}

// ============== 工具 ==============

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp3": "mp3",
    "audio/mpeg": "mp3",
  };
  return map[mime] ?? "bin";
}

/**
 * 按"用户 / 类型 / 年月 / uuid.ext"分目录，便于排查和 OSS 生命周期管理
 * 例：users/123/images/2026-05/8a3f...e1.png
 */
export function buildKey(opts: { userId: number; kind: AssetKind; mime: string }): string {
  const uuid = crypto.randomBytes(16).toString("hex");
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const ext = extFromMime(opts.mime);
  return `users/${opts.userId}/${opts.kind}s/${ym}/${uuid}.${ext}`;
}

// ============== 核心 API ==============

/**
 * 上传文件
 * 对大文件（>1MB）自动使用分块上传
 */
export async function putObject(input: PutObjectInput): Promise<PutObjectResult> {
  const { ossKey, body, mime } = input;

  if (isDryRun()) {
    const absPath = path.join(MOCK_ROOT, ossKey);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    if (Buffer.isBuffer(body)) {
      await fs.writeFile(absPath, body);
      console.log(`[OSS:mock] put ${ossKey} size=${body.length}B`);
      return { ossKey, size: body.length, mime };
    }

    const ws = createWriteStream(absPath);
    await pipeline(body, ws);
    const stat = await fs.stat(absPath);
    console.log(`[OSS:mock] put ${ossKey} size=${stat.size}B`);
    return { ossKey, size: stat.size, mime };
  }

  const client = await getOssClient();
  const buf = Buffer.isBuffer(body) ? body : await streamToBuffer(body);

  // 大文件使用分块上传（>1MB）- 使用临时文件方式
  const ONE_MB = 1024 * 1024;
  if (buf.length > ONE_MB) {
    console.log(`[OSS] 使用分块上传: ${ossKey} size=${(buf.length / 1024 / 1024).toFixed(2)}MB`);

    // 创建临时文件
    const tmpDir = path.resolve(process.cwd(), "tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `upload-${Date.now()}.tmp`);

    try {
      // 写入临时文件
      await fs.writeFile(tmpFile, buf);

      // 使用临时文件路径进行分块上传
      const r = await client.multipartUpload(ossKey, tmpFile, {
        mime,
        headers: {
          'Content-Disposition': mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')
            ? 'inline'
            : 'attachment',
        },
        partSize: ONE_MB,
        progress: (p: number) => {
          if (Math.floor(p) % 10 === 0) {
            console.log(`[OSS] 上传进度: ${Math.floor(p)}%`);
          }
        },
      });

      console.log(`[OSS] 分块上传完成: ${ossKey}`);
      return { ossKey: r.name, size: buf.length, mime };
    } finally {
      // 清理临时文件
      try {
        await fs.unlink(tmpFile);
      } catch { /* ignore */ }
    }
  }

  // 小文件直接上传
  const r = await client.put(ossKey, buf, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': mime.startsWith('image/') || mime.startsWith('video/')
        ? 'inline'  // 浏览器内预览
        : 'attachment',  // 其他文件下载
    }
  });
  console.log(`[OSS] put ${ossKey} size=${buf.length}B`);
  return { ossKey: r.name, size: buf.length, mime };
}

/**
 * 从第三方 URL 拉文件并上传 OSS（poller 主要用法）
 */
export async function putFromRemoteUrl(opts: {
  url: string;
  ossKey: string;
  mime?: string;
}): Promise<PutObjectResult> {
  const resp = await fetch(opts.url);
  if (!resp.ok) {
    throw new Error(`远程拉取失败 ${resp.status}: ${opts.url.slice(0, 80)}`);
  }
  const mime = opts.mime || resp.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await resp.arrayBuffer());
  return putObject({ ossKey: opts.ossKey, body: buf, mime });
}

/**
 * 生成临时签名 URL（前端展示用，默认 1h）
 */
export async function getSignedUrl(ossKey: string, ttlSeconds = SIGN_TTL_SECONDS): Promise<string> {
  if (isDryRun()) {
    // 简单加 expires 参数（仅做语义占位，dry-run 路由会无视过期判断）
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${MOCK_URL_PREFIX}/${encodeURI(ossKey)}?expires=${expires}`;
  }
  const client = await getOssClient();
  // 添加 response-content-disposition=inline 让图片在浏览器中预览而不是下载
  return client.signatureUrl(ossKey, {
    expires: ttlSeconds,
    response: {
      'content-disposition': 'inline',
    },
  });
}

/**
 * 批量签名（画廊接口高频用）
 */
export async function getSignedUrls(
  ossKeys: string[],
  ttlSeconds = SIGN_TTL_SECONDS
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all(
    ossKeys.map(async (k) => {
      result[k] = await getSignedUrl(k, ttlSeconds);
    })
  );
  return result;
}

/**
 * 物理删除（清理 cron 用，业务删除走软删）
 */
export async function deleteObject(ossKey: string): Promise<void> {
  if (isDryRun()) {
    const absPath = path.join(MOCK_ROOT, ossKey);
    try {
      await fs.unlink(absPath);
      console.log(`[OSS:mock] delete ${ossKey}`);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    return;
  }
  const client = await getOssClient();
  await client.delete(ossKey);
  console.log(`[OSS] delete ${ossKey}`);
}

/**
 * dry-run 路由用：根据 ossKey 读本地文件（流式）
 */
export async function readMockObject(ossKey: string): Promise<{
  stream: NodeJS.ReadableStream;
  size: number;
  mime: string;
} | null> {
  if (!isDryRun()) return null;
  const absPath = path.join(MOCK_ROOT, ossKey);
  try {
    const stat = await fs.stat(absPath);
    const ext = path.extname(ossKey).toLowerCase().slice(1);
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
    };
    return {
      stream: createReadStream(absPath),
      size: stat.size,
      mime: mimeMap[ext] ?? "application/octet-stream",
    };
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// ============== 内部工具 ==============

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export const OssService = {
  isDryRun,
  buildKey,
  putObject,
  putFromRemoteUrl,
  getSignedUrl,
  getSignedUrls,
  deleteObject,
  readMockObject,
};

export default OssService;

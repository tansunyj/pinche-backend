/**
 * 详细 HTTP 请求/响应日志（表：proxy_request_logs，见 002/003 migration）
 *
 * 与 proxy_logs 的区别：
 *   - proxy_logs：每次代理调用的计费摘要（token、latency、tokens、quota、status）
 *   - proxy_request_logs：完整 HTTP 报文（headers、body、is_stream、stream_chunks 等）
 *
 * 设计要点：
 *   1. 采样：env REQUEST_LOG_SAMPLE_RATE (0~1，默认 1.0)，错误/非 2xx 始终采样
 *   2. 截断：env REQUEST_LOG_MAX_BODY_BYTES (默认 64 KiB)
 *   3. 脱敏：剥离 authorization / api-key 等敏感 header
 *   4. 不阻塞主流程：insert 失败仅打印 error
 */

const { query } = require('../db/init');

const SAMPLE_RATE = (() => {
  const v = parseFloat(process.env.REQUEST_LOG_SAMPLE_RATE);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1.0;
})();

const MAX_BODY_BYTES = (() => {
  const v = parseInt(process.env.REQUEST_LOG_MAX_BODY_BYTES, 10);
  return Number.isFinite(v) && v > 0 ? v : 64 * 1024;
})();

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization', 'x-api-key', 'api-key', 'proxy-authorization',
  'cookie', 'set-cookie', 'x-auth-token',
]);

function sanitizeHeaders(headers) {
  if (!headers) return null;
  const out = {};
  // headers 可能是 fetch Headers 实例 / 普通对象 / 数组
  const entries = typeof headers.entries === 'function'
    ? Array.from(headers.entries())
    : Object.entries(headers);
  for (const [k, v] of entries) {
    const lower = String(k).toLowerCase();
    out[lower] = SENSITIVE_HEADER_KEYS.has(lower) ? '***' : String(v).slice(0, 2048);
  }
  return out;
}

function truncate(str, max = MAX_BODY_BYTES) {
  if (str == null) return null;
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  // 按字节截断（保险起见，先转 Buffer 再切）
  const buf = Buffer.from(s, 'utf8').slice(0, max);
  return buf.toString('utf8') + `...[truncated, original_bytes=${Buffer.byteLength(s, 'utf8')}]`;
}

/**
 * 是否应写入？采样率 + 强制策略
 */
function shouldLog({ isError }) {
  if (isError) return true;
  if (SAMPLE_RATE >= 1) return true;
  if (SAMPLE_RATE <= 0) return false;
  return Math.random() < SAMPLE_RATE;
}

/**
 * 写入一行 proxy_request_logs
 *
 * @param {object} entry
 *   @param {string} entry.requestId
 *   @param {number} entry.userId         令牌所属用户 ID（没有就传 0）
 *   @param {number} [entry.tokenId]
 *   @param {number} [entry.channelId]
 *   @param {string} entry.model
 *   @param {string} entry.requestMethod  GET/POST/...
 *   @param {string} entry.requestPath    /v1/chat/completions ...
 *   @param {object} [entry.requestHeaders]
 *   @param {*}      [entry.requestBody]
 *   @param {number} [entry.requestSizeBytes]
 *   @param {number} [entry.responseStatus]
 *   @param {object} [entry.responseHeaders]
 *   @param {*}      [entry.responseBody]
 *   @param {number} [entry.responseSizeBytes]
 *   @param {boolean}[entry.isStream]
 *   @param {number} [entry.streamChunks]
 *   @param {number} [entry.firstChunkLatencyMs]
 *   @param {number} [entry.totalLatencyMs]
 *   @param {number} [entry.promptTokens]
 *   @param {number} [entry.completionTokens]
 *   @param {number} [entry.totalTokens]
 *   @param {number} [entry.costPoints]
 *   @param {string} [entry.errorCode]
 *   @param {string} [entry.errorMessage]
 *   @param {string} [entry.clientIp]
 *   @param {string} [entry.userAgent]
 */
async function insert(entry) {
  try {
    const isError = entry.responseStatus != null && entry.responseStatus >= 400;
    if (!shouldLog({ isError })) return;

    const reqHeaders = sanitizeHeaders(entry.requestHeaders);
    const resHeaders = sanitizeHeaders(entry.responseHeaders);
    const reqBody = truncate(entry.requestBody);
    const resBody = truncate(entry.responseBody);

    await query(
      `INSERT INTO proxy_request_logs
        (request_id, user_id, token_id, channel_id, model,
         request_method, request_path, request_headers, request_body, request_size_bytes,
         response_status, response_headers, response_body, response_size_bytes,
         is_stream, stream_chunks, first_chunk_latency_ms, total_latency_ms,
         prompt_tokens, completion_tokens, total_tokens, cost_points,
         error_code, error_message, client_ip, user_agent, completed_at)
       VALUES (?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?, ?, ?, NOW())`,
      [
        entry.requestId,
        entry.userId || 0,
        entry.tokenId || null,
        entry.channelId || null,
        (entry.model || '').slice(0, 100),
        (entry.requestMethod || 'POST').slice(0, 10),
        (entry.requestPath || '').slice(0, 255),
        reqHeaders ? JSON.stringify(reqHeaders) : null,
        reqBody,
        entry.requestSizeBytes || (reqBody ? Buffer.byteLength(reqBody, 'utf8') : 0),
        entry.responseStatus || null,
        resHeaders ? JSON.stringify(resHeaders) : null,
        resBody,
        entry.responseSizeBytes || (resBody ? Buffer.byteLength(resBody, 'utf8') : 0),
        entry.isStream ? 1 : 0,
        entry.streamChunks || 0,
        entry.firstChunkLatencyMs || 0,
        entry.totalLatencyMs || 0,
        entry.promptTokens || 0,
        entry.completionTokens || 0,
        entry.totalTokens || (entry.promptTokens || 0) + (entry.completionTokens || 0),
        entry.costPoints || 0,
        entry.errorCode ? String(entry.errorCode).slice(0, 50) : null,
        entry.errorMessage ? String(entry.errorMessage).slice(0, 1000) : null,
        entry.clientIp ? String(entry.clientIp).slice(0, 45) : null,
        entry.userAgent ? String(entry.userAgent).slice(0, 500) : null,
      ]
    );
  } catch (e) {
    // 审计失败不影响主流程
    console.error('[RequestLog] insert failed:', e.message);
  }
}

module.exports = {
  insert,
  sanitizeHeaders,
  truncate,
};

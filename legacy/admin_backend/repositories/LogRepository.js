const { query } = require('../db/init');

const INSERT_SQL = `INSERT INTO proxy_logs
  (user_id, token_id, token_name, channel_id, channel_name, model,
   prompt_tokens, completion_tokens, quota_consumed, latency_ms,
   status, error_msg, is_thinking, price_markup, request_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function buildParams(entry) {
  return [
    entry.userId || 0,
    entry.tokenId,
    entry.tokenName,
    entry.channelId || 0,
    entry.channelName,
    entry.model,
    entry.promptTokens || 0,
    entry.completionTokens || 0,
    entry.quotaConsumed || 0,
    entry.latencyMs || 0,
    entry.status,
    entry.errorMsg || '',
    entry.isThinking ? 1 : 0,
    entry.priceMarkup || 1.0,
    entry.requestId || null,
  ];
}

async function insert(entry) {
  await query(INSERT_SQL, buildParams(entry));
}

/**
 * 支持外部事务的 insert
 */
async function insertWithConn(connection, entry) {
  await connection.execute(INSERT_SQL, buildParams(entry));
}

module.exports = { insert, insertWithConn };

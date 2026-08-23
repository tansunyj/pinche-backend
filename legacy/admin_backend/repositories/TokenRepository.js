const { query } = require('../db/init');

async function findByKey(key) {
  const rows = await query('SELECT * FROM proxy_tokens WHERE `key` = ? AND status = 1', [key]);
  return rows[0] || null;
}

async function consumeQuota(tokenId, quotaConsumed) {
  // 注意：MySQL 的 MAX(0, remain_quota - ?) 语法相同
  await query(
    'UPDATE proxy_tokens SET used_quota = used_quota + ?, remain_quota = GREATEST(0, CAST(remain_quota AS SIGNED) - ?) WHERE id = ?',
    [quotaConsumed, quotaConsumed, tokenId]
  );
}

async function consumeQuotaUnlimited(tokenId, quotaConsumed) {
  await query('UPDATE proxy_tokens SET used_quota = used_quota + ? WHERE id = ?', [quotaConsumed, tokenId]);
}

async function applyUsage(tokenId, quotaConsumed) {
  const rows = await query('SELECT quota FROM proxy_tokens WHERE id = ?', [tokenId]);
  const token = rows[0];
  if (!token) return;

  if (token.quota > 0) {
    await consumeQuota(tokenId, quotaConsumed);
  } else {
    await consumeQuotaUnlimited(tokenId, quotaConsumed);
  }
}

/**
 * 支持外部事务的 applyUsage
 */
async function applyUsageWithConn(connection, tokenId, quotaConsumed) {
  const [rows] = await connection.execute('SELECT quota FROM proxy_tokens WHERE id = ?', [tokenId]);
  const token = rows[0];
  if (!token) return;

  if (token.quota > 0) {
    await connection.execute(
      'UPDATE proxy_tokens SET used_quota = used_quota + ?, remain_quota = GREATEST(0, CAST(remain_quota AS SIGNED) - ?) WHERE id = ?',
      [quotaConsumed, quotaConsumed, tokenId]
    );
  } else {
    await connection.execute('UPDATE proxy_tokens SET used_quota = used_quota + ? WHERE id = ?', [quotaConsumed, tokenId]);
  }
}

module.exports = {
  findByKey,
  applyUsage,
  consumeQuota,
  consumeQuotaUnlimited,
  applyUsageWithConn
};

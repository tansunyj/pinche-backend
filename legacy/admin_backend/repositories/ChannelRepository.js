const { query } = require('../db/init');

/**
 * 列出所有启用的渠道（无模型过滤）
 * 用途：管理后台、统计场景。**路由判断不要用此函数**，请用 listChannelsForModel。
 */
async function listActive() {
  return await query(
    'SELECT * FROM proxy_channels WHERE status = 1 ORDER BY priority DESC, weight DESC'
  );
}

async function findById(id) {
  const rows = await query(
    'SELECT * FROM proxy_channels WHERE id = ? AND status = 1',
    [id]
  );
  return rows[0] || null;
}

/**
 * 列出"对该模型可用"的渠道（路由真相源）
 *
 * 走 proxy_channel_models junction 表：
 *   - 精确匹配 cm.model_id = model
 *   - 通配符渠道 cm.model_id = '*'（接所有模型的兜底）
 *
 * 返回字段：proxy_channels.* + 来自 junction 的 cm_priority / cm_markup /
 * cm_rate_limit_rps / cm_rate_limit_rpm / cm_is_wildcard
 *
 * 评分时 cm_priority 优先于 channel.priority，cm_markup 优先于 token.price_markup
 *
 * @param {string} model
 * @returns {Promise<Array>}
 */
async function listChannelsForModel(model) {
  return await query(
    `
    SELECT c.*,
           cm.priority       AS cm_priority,
           cm.markup         AS cm_markup,
           cm.rate_limit_rps AS cm_rate_limit_rps,
           cm.rate_limit_rpm AS cm_rate_limit_rpm,
           CASE WHEN cm.model_id = '*' THEN 1 ELSE 0 END AS cm_is_wildcard
      FROM proxy_channels c
      JOIN proxy_channel_models cm ON cm.channel_id = c.id
     WHERE c.status = 1
       AND cm.is_enabled = 1
       AND (cm.model_id = ? OR cm.model_id = '*')
     ORDER BY
       CASE WHEN cm.model_id = '*' THEN 1 ELSE 0 END ASC,  -- 精确匹配优先
       COALESCE(cm.priority, c.priority) DESC,
       c.weight DESC
    `,
    [model]
  );
}

/**
 * 列出某渠道支持的所有模型 ID（含通配符）
 * 用于 GET /v1/models 之类列表接口
 */
async function listModelsForChannel(channelId) {
  const rows = await query(
    `SELECT model_id
       FROM proxy_channel_models
      WHERE channel_id = ? AND is_enabled = 1`,
    [channelId]
  );
  return rows.map(r => r.model_id);
}

module.exports = {
  listActive,
  findById,
  listChannelsForModel,
  listModelsForChannel,
};

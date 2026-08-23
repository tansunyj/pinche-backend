const { query } = require('../db/init');

class PriceRepository {
    /**
   * 获取模型价格列表（支持分页、搜索、过滤）
   */
    async listAll({ page = 1, pageSize = 20, search = '', type = 'all' } = {}) {
        let sql = 'SELECT * FROM proxy_model_prices WHERE 1=1';
        const params = [];

        if (search) {
            sql += ' AND LOWER(model) LIKE LOWER(?)';
            params.push(`%${search.toLowerCase()}%`);
        }

        if (type && type !== 'all') {
            sql += ' AND type = ?';
            params.push(type);
        }

        // 获取总数
        const countSql = `SELECT COUNT(*) as total FROM (${sql}) as t`;
        const countResult = await query(countSql, params);
        const total = countResult[0].total;

        // 分页参数安全处理
        const limit = Math.max(1, parseInt(pageSize) || 20);
        const offset = Math.max(0, (parseInt(page) - 1) * limit);

        // 使用字符串拼接处理 LIMIT/OFFSET (mysql2 execute 对此参数的支持在某些版本有 bug)
        // 既然我们已经用 Math.max 和 parseInt 确保了它们是纯数字，所以是安全的
        sql += ` ORDER BY model ASC, max_input_tokens ASC LIMIT ${limit} OFFSET ${offset}`;

        const rows = await query(sql, params);
        const data = rows.map(row => ({
            model: row.model,
            type: row.type,
            maxInputTokens: row.max_input_tokens,
            inputPricePerM: parseFloat(row.input_price_per_m),
            outputPricePerM: parseFloat(row.output_price_per_m),
            thinkingOutputPerM: parseFloat(row.thinking_output_per_m),
            pricePerImage: parseFloat(row.price_per_image),
            pricePerSecond720: parseFloat(row.price_per_second_720),
            pricePerSecond1080: parseFloat(row.price_per_second_1080),
            tierLabel: row.tier_label,
            // video_token 类型的额外配置
            // 官方价格：480p和720p同价(46/28)，1080p(51/31)，4k(26/16)
            ...(row.type === 'video_token' && row.config_json ? {
                videoTokenPrices: {
                    '480p_noInput': parseFloat(row.config_json['480p_noInput'] || 46.00),
                    '480p_withInput': parseFloat(row.config_json['480p_withInput'] || 28.00),
                    '720p_noInput': parseFloat(row.config_json['720p_noInput'] || 46.00),
                    '720p_withInput': parseFloat(row.config_json['720p_withInput'] || 28.00),
                    '1080p_noInput': parseFloat(row.config_json['1080p_noInput'] || 51.00),
                    '1080p_withInput': parseFloat(row.config_json['1080p_withInput'] || 31.00),
                    '4k_noInput': parseFloat(row.config_json['4k_noInput'] || 26.00),
                    '4k_withInput': parseFloat(row.config_json['4k_withInput'] || 16.00),
                }
            } : {})
        }));

        return { data, total };
    }

    /**
     * 按模型名称查找价格（可能返回多条阶梯）
     */
    async findByModel(model) {
        const rows = await query('SELECT * FROM proxy_model_prices WHERE model = ? ORDER BY max_input_tokens ASC', [model]);
        return rows.map(row => ({
            model: row.model,
            type: row.type,
            maxInputTokens: row.max_input_tokens,
            inputPricePerM: parseFloat(row.input_price_per_m),
            outputPricePerM: parseFloat(row.output_price_per_m),
            thinkingOutputPerM: parseFloat(row.thinking_output_per_m),
            pricePerImage: parseFloat(row.price_per_image),
            pricePerSecond720: parseFloat(row.price_per_second_720),
            pricePerSecond1080: parseFloat(row.price_per_second_1080),
            tierLabel: row.tier_label,
            // video_token 类型的额外配置
            // 官方价格：480p和720p同价(46/28)，1080p(51/31)，4k(26/16)
            ...(row.type === 'video_token' && row.config_json ? {
                videoTokenPrices: {
                    '480p_noInput': parseFloat(row.config_json['480p_noInput'] || 46.00),
                    '480p_withInput': parseFloat(row.config_json['480p_withInput'] || 28.00),
                    '720p_noInput': parseFloat(row.config_json['720p_noInput'] || 46.00),
                    '720p_withInput': parseFloat(row.config_json['720p_withInput'] || 28.00),
                    '1080p_noInput': parseFloat(row.config_json['1080p_noInput'] || 51.00),
                    '1080p_withInput': parseFloat(row.config_json['1080p_withInput'] || 31.00),
                    '4k_noInput': parseFloat(row.config_json['4k_noInput'] || 26.00),
                    '4k_withInput': parseFloat(row.config_json['4k_withInput'] || 16.00),
                }
            } : {})
        }));
    }
}

module.exports = new PriceRepository();

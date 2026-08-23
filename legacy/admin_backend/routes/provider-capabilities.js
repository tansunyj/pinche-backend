/**
 * Adapter 能力清单（provider_capabilities 表）
 *
 * 数据由网关启动时从 ProviderCapabilityCatalog 枚举 upsert 同步（枚举是真相源，表是物化副本）。
 * 本接口直连 MySQL 读表，供前端「渠道模型抽屉」的 Adapter 下拉使用，并按 domain 分组：
 *   GET /api/admin/provider-capabilities
 *   → { success, data: [{ domain:'chat', items:[{provider_alias,name,class_name}] }, ...] }
 */

const express = require('express');
const { query } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// 保持枚举声明顺序（chat → image → video → audio → embedding → rerank）
const DOMAIN_ORDER = ['chat', 'image', 'video', 'audio', 'embedding', 'rerank'];

router.get('/', async (req, res) => {
  try {
    const rows = await query(
      'SELECT provider_alias, domain, name, class_name FROM provider_capabilities ORDER BY id ASC'
    );
    const list = Array.isArray(rows) ? rows : [];

    const result = DOMAIN_ORDER
      .map(domain => ({
        domain,
        items: list
          .filter(r => r.domain === domain)
          .map(r => ({ provider_alias: r.provider_alias, name: r.name, class_name: r.class_name })),
      }))
      .filter(g => g.items.length > 0);

    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[provider-capabilities] list error:', e);
    res.status(500).json({ success: false, error: '获取能力清单失败' });
  }
});

module.exports = router;

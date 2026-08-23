const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const priceRepository = require('../repositories/PriceRepository');

const publicRouter = express.Router();
const adminRouter = express.Router();
adminRouter.use(authMiddleware);

/**
 * 获取所有模型价格列表
 */
publicRouter.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 20;
        const search = (req.query.search || '').trim();
        const type = (req.query.type || 'all').trim();

        console.log(`[Pricing API] Page: ${page}, Size: ${pageSize}, Search: "${search}", Type: "${type}"`);

        const { data, total } = await priceRepository.listAll({ page, pageSize, search, type });
        console.log(`[Pricing API] Found ${data.length}/${total} rows`);
        res.json({
            success: true,
            data,
            total,
            page,
            pageSize
        });
    } catch (err) {
        console.error('[API Error] 获取价格列表失败:', err);
        res.status(500).json({ success: false, error: '获取价格列表失败' });
    }
});

/**
 * 刷新价格缓存
 */
adminRouter.post('/refresh', async (req, res) => {
    try {
        const { loadPricesFromDb } = require('../utils/billing');
        await loadPricesFromDb();
        res.json({ success: true, message: '价格缓存已刷新' });
    } catch (err) {
        console.error('[API Error] 刷新价格缓存失败:', err);
        res.status(500).json({ success: false, error: '刷新失败' });
    }
});

module.exports = { publicRouter, adminRouter };

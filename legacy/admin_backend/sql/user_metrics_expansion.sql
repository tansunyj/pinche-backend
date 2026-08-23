-- ============================================
-- 用户监控指标扩充方案
-- 在现有24个指标基础上，新增用户维度指标
-- ============================================

-- 1. 在 metric_definitions 表中添加用户相关指标定义
INSERT INTO metric_definitions (metric_name, metric_type, description, unit) VALUES
-- 用户增长指标
('new_users', 'counter', '新注册用户数量', 'count'),
('active_users', 'gauge', '日活跃用户数(DAU)', 'count'),
('user_sessions', 'counter', '用户登录会话次数', 'count'),

-- Token管理指标
('tokens_created', 'counter', '当日创建Token数量', 'count'),
('active_tokens', 'gauge', '当日活跃Token数量', 'count'),
('tokens_expired', 'counter', '当日过期Token数量', 'count'),

-- 充值与财务指标
('recharge_orders', 'counter', '充值订单数量', 'count'),
('recharge_amount', 'counter', '充值金额(分)', 'count'),
('recharge_success', 'counter', '充值成功次数', 'count'),
('recharge_failed', 'counter', '充值失败次数', 'count'),

-- 消费与余额指标
('balance_consumed', 'counter', '余额消费(分)', 'count'),
('balance_recharged', 'counter', '余额充值(分)', 'count'),
('users_with_quota', 'gauge', '有余额的用户数', 'count'),
('users_zero_quota', 'gauge', '余额为0的用户数', 'count'),

-- 用户行为指标
('users_with_requests', 'gauge', '有API请求的用户数', 'count'),
('avg_requests_per_user', 'gauge', '平均每用户请求数', 'count'),
('avg_quota_per_user', 'gauge', '平均每用户消费(分)', 'count');

-- ============================================
-- 2. 创建用户统计专用的 Redis 数据结构
-- ============================================

-- 全局用户统计 (hash)
-- key: stats:user:global:YYYY-MM-DD
-- fields:
--   new_users: 新注册用户
--   active_users: 活跃用户数(DAU)
--   logins: 登录次数
--   tokens_created: 创建token数
--   recharge_orders: 充值订单数
--   recharge_amount: 充值金额
--   balance_consumed: 余额消费

-- 单用户统计 (hash)
-- key: stats:user:{user_id}:YYYY-MM-DD
-- fields:
--   requests: 请求数
--   quota: 消费额度
--   tokens: token数量
--   last_active: 最后活跃时间

-- 用户活跃集合 (HyperLogLog)
-- key: stats:dau:YYYY-MM-DD  (已存在)
-- key: stats:user:active:YYYY-MM-DD  (新增)

-- 充值统计 (hash)
-- key: stats:billing:YYYY-MM-DD
-- fields:
--   orders_count: 订单数
--   orders_success: 成功数
--   orders_failed: 失败数
--   amount_total: 总金额
--   amount_paid: 实付金额
--   users_recharged: 充值用户数

-- ============================================
-- 3. 在 unified_stats 表中存储用户维度数据
-- ============================================
-- dim_type = 'user_global'  - 用户全局统计
-- dim_type = 'user_detail'  - 单用户统计
-- dim_type = 'billing'      - 充值消费统计

-- 示例查询：
-- 查询某日新注册用户数
-- SELECT metric_value FROM unified_stats
-- WHERE stat_date = '2026-05-24' AND dim_type = 'user_global' AND metric_name = 'new_users';

-- 查询某日充值总额
-- SELECT metric_value FROM unified_stats
-- WHERE stat_date = '2026-05-24' AND dim_type = 'billing' AND metric_name = 'recharge_amount';

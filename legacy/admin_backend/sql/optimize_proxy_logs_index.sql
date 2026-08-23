-- 优化 proxy_logs 表的查询性能
-- 为 latency 相关查询创建复合索引

-- 索引1: 用于延迟分布查询 (created_at + latency_ms)
-- 支持：按时间范围过滤 + latency_ms 统计
CREATE INDEX IF NOT EXISTS `idx_proxy_logs_latency_created`
ON `proxy_logs` (`created_at`, `latency_ms`);

-- 索引2: 用于按 id 倒序查询最近记录（支持 ORDER BY id DESC）
-- 注意：这个索引覆盖 created_at 条件，支持最近延迟记录查询
CREATE INDEX IF NOT EXISTS `idx_proxy_logs_created_id`
ON `proxy_logs` (`created_at`, `id`, `token_name`, `model`, `latency_ms`);

-- 检查索引是否创建成功
SHOW INDEX FROM proxy_logs;

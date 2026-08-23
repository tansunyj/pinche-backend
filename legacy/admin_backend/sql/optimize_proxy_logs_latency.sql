-- 优化 proxy_logs 表的延迟统计查询性能

-- 索引1: 支持延迟统计查询（created_at + latency_ms 覆盖索引）
-- 用于：getLatencyDistributionFromLogs, getOverallLatencyFromLogs, getDailyLatencyFromLogs
-- 覆盖索引避免回表，提高聚合计算性能
CREATE INDEX IF NOT EXISTS `idx_proxy_logs_latency_stats`
ON `proxy_logs` (`created_at`, `latency_ms`);

-- 检查索引是否创建成功
SHOW INDEX FROM proxy_logs;

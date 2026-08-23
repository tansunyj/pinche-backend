-- ============================================================
-- 017_add_proxy_logs_user_created_index.sql
-- 为 proxy_logs 添加 (user_id, created_at) 复合索引
-- 用于：用户消费聚合查询（/api/usage/summary）与后台按用户查消费记录
--   WHERE user_id = ? AND created_at >= ? ...
-- 生产环境已是 (user_id, created_at) 顺序；dev 当前是 (created_at, user_id)，
-- 聚合查询以 user_id 等值 + created_at 范围为主，补一个 user 前置的复合索引更优。
-- ============================================================

SET NAMES utf8mb4;

-- 添加复合索引（如果不存在）
SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'proxy_logs'
      AND INDEX_NAME = 'idx_proxy_logs_user_created'
  ),
  'ALTER TABLE `proxy_logs` ADD INDEX `idx_proxy_logs_user_created` (`user_id`, `created_at`) USING BTREE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 验证
SHOW INDEX FROM proxy_logs WHERE Key_name = 'idx_proxy_logs_user_created';

-- ============================================================
-- 完成
-- ============================================================

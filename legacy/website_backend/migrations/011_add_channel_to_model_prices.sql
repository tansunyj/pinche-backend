-- ============================================================
-- 011_add_channel_to_model_prices.sql
-- 为 model_prices 表添加 channel_id 和 channel_name 字段
-- 用于支持按渠道显示不同价格
-- ============================================================

SET NAMES utf8mb4;

-- 添加 channel_id 字段（如果不存在）
SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'model_prices' AND COLUMN_NAME = 'channel_id'
  ),
  'ALTER TABLE `model_prices` ADD COLUMN `channel_id` INT UNSIGNED DEFAULT NULL COMMENT "关联 proxy_channels.id"',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 添加 channel_name 字段（如果不存在）
SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'model_prices' AND COLUMN_NAME = 'channel_name'
  ),
  'ALTER TABLE `model_prices` ADD COLUMN `channel_name` VARCHAR(100) DEFAULT NULL COMMENT "渠道名称（冗余，方便查询）"',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 添加索引（如果不存在）
SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_NAME = 'model_prices' AND INDEX_NAME = 'idx_price_channel'
  ),
  'ALTER TABLE `model_prices` ADD KEY `idx_price_channel` (`channel_id`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================
-- 完成
-- ============================================================

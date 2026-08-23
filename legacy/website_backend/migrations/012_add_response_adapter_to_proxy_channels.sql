-- ============================================================
-- 012_add_response_adapter_to_proxy_channels.sql
-- 为 proxy_channels 表添加 response_adapter 字段
-- 用于配置该渠道返回的响应格式适配器
-- ============================================================

SET NAMES utf8mb4;

-- 添加 response_adapter 字段（如果不存在）
SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'proxy_channels' AND COLUMN_NAME = 'response_adapter'
  ),
  'ALTER TABLE `proxy_channels` ADD COLUMN `response_adapter` VARCHAR(50) DEFAULT NULL COMMENT "响应格式适配器: auto(自动检测), responses_api, anthropic, openai_standard"',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 验证
SELECT id, name, type, response_adapter
FROM proxy_channels
LIMIT 5;

-- ============================================================
-- 完成
-- ============================================================

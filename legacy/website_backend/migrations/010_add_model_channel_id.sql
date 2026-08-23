-- ============================================================
-- 010_add_model_channel_id.sql
-- 为 model_library 表添加 channel_id 字段
-- 用于关联 proxy_channels 表，实现模型级别的渠道配置
-- ============================================================

SET NAMES utf8mb4;

-- 添加 channel_id 字段（如果不存在）
SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'model_library' AND COLUMN_NAME = 'channel_id'
  ),
  'ALTER TABLE `model_library` ADD COLUMN `channel_id` INT UNSIGNED DEFAULT NULL COMMENT "关联 proxy_channels.id"',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 添加外键（可选，如果不需要强约束可以注释掉）
-- SET @sql := IF(
--   NOT EXISTS(
--     SELECT 1 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
--     WHERE TABLE_NAME = 'model_library' AND COLUMN_NAME = 'channel_id' AND REFERENCED_TABLE_NAME IS NOT NULL
--   ),
--   'ALTER TABLE `model_library` ADD CONSTRAINT `fk_model_channel` FOREIGN KEY (`channel_id`) REFERENCES `proxy_channels`(`id`) ON DELETE SET NULL',
--   'SELECT 1'
-- );
-- PREPARE stmt FROM @sql;
-- EXECUTE stmt;
-- DEALLOCATE PREPARE stmt;

-- 为 WanX 模型设置默认渠道（假设 proxy_channels 中有 alibaba 类型的渠道）
-- 先查找第一个 alibaba 类型的渠道
SET @alibaba_channel_id := (
  SELECT id FROM proxy_channels
  WHERE status = 1 AND (type = 'alibaba' OR name LIKE '%aliyun%' OR name LIKE '%dashscope%')
  ORDER BY priority DESC, id ASC
  LIMIT 1
);

-- 更新模型表中 category='image' 且 channel_id 为空的记录
UPDATE `model_library`
SET `channel_id` = @alibaba_channel_id
WHERE `category` = 'image'
  AND `provider` = 'alibaba'
  AND `channel_id` IS NULL
  AND @alibaba_channel_id IS NOT NULL;

-- 验证
SELECT model_id, display_name, provider, channel_id
FROM model_library
WHERE category = 'image' AND provider = 'alibaba';

-- ============================================================
-- 完成
-- ============================================================
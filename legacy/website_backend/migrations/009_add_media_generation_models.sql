-- ============================================================
-- 009_add_media_generation_models.sql
-- 添加媒体生成模型（WanX、Kling等）到模型广场
-- 用于创作工坊（/studio）的图片/视频生成功能
-- ============================================================

SET NAMES utf8mb4;

-- 图片生成模型（WanX 系列）
INSERT INTO `model_library` (`model_id`, `display_name`, `description`, `category`, `provider`, `capabilities`, `status`, `is_visible`, `sort_order`, `created_at`)
VALUES
  ('wanx2.1-t2i-turbo', 'WanX 2.1 文生图-Turbo', '阿里云万相2.1文生图模型，快速生成高质量图片', 'image', 'wanx', '["text-to-image", "image-generation"]', 1, 1, 1, NOW()),
  ('wanx2.1-t2i-plus', 'WanX 2.1 文生图-Plus', '阿里云万相2.1文生图增强版，更高质量', 'image', 'wanx', '["text-to-image", "image-generation"]', 1, 1, 2, NOW()),
  ('wanx2.1-i2i', 'WanX 2.1 图生图', '阿里云万相2.1图生图模型，基于参考图生成', 'image', 'wanx', '["image-to-image", "image-generation"]', 1, 1, 3, NOW()),
  ('wanx2.1-style', 'WanX 2.1 风格迁移', '阿里云万相2.1风格迁移模型', 'image', 'wanx', '["style-transfer", "image-generation"]', 1, 1, 4, NOW())
ON DUPLICATE KEY UPDATE
  `display_name` = VALUES(`display_name`),
  `description` = VALUES(`description`),
  `category` = VALUES(`category`),
  `capabilities` = VALUES(`capabilities`),
  `updated_at` = NOW();

-- 视频生成模型（Kling 系列）
INSERT INTO `model_library` (`model_id`, `display_name`, `description`, `category`, `provider`, `capabilities`, `status`, `is_visible`, `sort_order`, `created_at`)
VALUES
  ('kling-v1', 'Kling V1 视频生成', '快手可灵V1视频生成模型，文生视频', 'video', 'kling', '["text-to-video", "video-generation"]', 1, 1, 10, NOW()),
  ('kling-v1-i2v', 'Kling V1 图生视频', '快手可灵V1图生视频模型，基于图片生成视频', 'video', 'kling', '["image-to-video", "video-generation"]', 1, 1, 11, NOW()),
  ('kling-v1-flf2v', 'Kling V1 首尾帧视频', '快手可灵V1首尾帧视频模型，基于首尾帧生成视频', 'video', 'kling', '["first-last-frame-to-video", "video-generation"]', 1, 1, 12, NOW()),
  ('kling-v1.5', 'Kling V1.5 高清视频', '快手可灵V1.5高清视频生成模型', 'video', 'kling', '["text-to-video", "video-generation", "high-quality"]', 1, 1, 13, NOW())
ON DUPLICATE KEY UPDATE
  `display_name` = VALUES(`display_name`),
  `description` = VALUES(`description`),
  `category` = VALUES(`category`),
  `capabilities` = VALUES(`capabilities`),
  `updated_at` = NOW();

-- 添加模型端点（用于媒体生成）
INSERT INTO `model_endpoints` (`model_id`, `endpoint_type`, `endpoint_path`, `is_default`, `status`, `sort_order`)
VALUES
  -- WanX 图片生成端点
  ('wanx2.1-t2i-turbo', 'images', '/v1/images/generations', 1, 1, 0),
  ('wanx2.1-t2i-plus', 'images', '/v1/images/generations', 1, 1, 0),
  ('wanx2.1-i2i', 'images', '/v1/images/edit', 1, 1, 0),
  ('wanx2.1-style', 'images', '/v1/images/style-transfer', 1, 1, 0),
  -- Kling 视频生成端点
  ('kling-v1', 'videos', '/v1/videos/generations', 1, 1, 0),
  ('kling-v1-i2v', 'videos', '/v1/videos/image-to-video', 1, 1, 0),
  ('kling-v1-flf2v', 'videos', '/v1/videos/first-last-frame', 1, 1, 0),
  ('kling-v1.5', 'videos', '/v1/videos/generations', 1, 1, 0)
ON DUPLICATE KEY UPDATE
  `endpoint_path` = VALUES(`endpoint_path`),
  `updated_at` = NOW();

-- 添加模型价格（创作工坊使用点数计费）
INSERT INTO `model_prices` (`model_id`, `endpoint_type`, `token_group_code`, `price_type`, `billing_mode`, `base_price`, `billing_params`, `status`)
VALUES
  -- WanX 图片生成价格（每张30点 ≈ 0.3元）
  ('wanx2.1-t2i-turbo', 'images', 'default', 'platform', 'per_image', 30, '{"unit_price_per_image": 30}', 1),
  ('wanx2.1-t2i-plus', 'images', 'default', 'platform', 'per_image', 50, '{"unit_price_per_image": 50}', 1),
  ('wanx2.1-i2i', 'images', 'default', 'platform', 'per_image', 40, '{"unit_price_per_image": 40}', 1),
  ('wanx2.1-style', 'images', 'default', 'platform', 'per_image', 60, '{"unit_price_per_image": 60}', 1),
  -- Kling 视频生成价格（每秒200-300点）
  ('kling-v1', 'videos', 'default', 'platform', 'per_second', 200, '{"unit_price_per_second": 200}', 1),
  ('kling-v1-i2v', 'videos', 'default', 'platform', 'per_second', 250, '{"unit_price_per_second": 250}', 1),
  ('kling-v1-flf2v', 'videos', 'default', 'platform', 'per_second', 300, '{"unit_price_per_second": 300}', 1),
  ('kling-v1.5', 'videos', 'default', 'platform', 'per_second', 350, '{"unit_price_per_second": 350}', 1)
ON DUPLICATE KEY UPDATE
  `base_price` = VALUES(`base_price`),
  `billing_params` = VALUES(`billing_params`),
  `updated_at` = NOW();

-- ============================================================
-- 完成
-- 验证 SQL：
--   SELECT model_id, display_name, category, provider FROM model_library WHERE category IN ('image', 'video');
--   SELECT * FROM model_endpoints WHERE model_id LIKE 'wanx%' OR model_id LIKE 'kling%';
--   SELECT * FROM model_prices WHERE model_id LIKE 'wanx%' OR model_id LIKE 'kling%';
-- ============================================================
-- ================================================
-- 添加 Seedance 视频模型到 media_models 表
-- ================================================

-- Seedance 2.0 系列模型
INSERT INTO media_models (
  model_id,
  display_name,
  provider,
  category,
  capabilities,
  description,
  config_json,
  is_active,
  created_at,
  updated_at
) VALUES (
  'seedance-2-0',
  'Seedance 2.0',
  'volcengine',
  'video',
  't2v,i2v',
  'Seedance 2.0 专业版视频生成模型，支持文生视频和图生视频',
  '{"mode": "pro", "supports_reference": true, "supports_audio": true}',
  1,
  NOW(),
  NOW()
) ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  provider = VALUES(provider),
  is_active = VALUES(is_active),
  updated_at = NOW();

INSERT INTO media_models (
  model_id,
  display_name,
  provider,
  category,
  capabilities,
  description,
  config_json,
  is_active,
  created_at,
  updated_at
) VALUES (
  'seedance-2-0-fast',
  'Seedance 2.0 Fast',
  'volcengine',
  'video',
  't2v,i2v',
  'Seedance 2.0 快速版视频生成模型，生成速度更快',
  '{"mode": "std", "supports_reference": true, "supports_audio": true}',
  1,
  NOW(),
  NOW()
) ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  provider = VALUES(provider),
  is_active = VALUES(is_active),
  updated_at = NOW();

INSERT INTO media_models (
  model_id,
  display_name,
  provider,
  category,
  capabilities,
  description,
  config_json,
  is_active,
  created_at,
  updated_at
) VALUES (
  'seedance-2-0-mini',
  'Seedance 2.0 Mini',
  'volcengine',
  'video',
  't2v,i2v',
  'Seedance 2.0 Mini 轻量版视频生成模型，适合快速预览',
  '{"mode": "std", "supports_reference": false, "supports_audio": false}',
  1,
  NOW(),
  NOW()
) ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  provider = VALUES(provider),
  is_active = VALUES(is_active),
  updated_at = NOW();

-- 可选：禁用旧的 wan2.7 系列模型
-- UPDATE media_models SET is_active = 0 WHERE model_id LIKE 'wan2.7%';

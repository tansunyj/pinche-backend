-- 为 media_jobs 表添加 provider_tokens 字段
-- 用于保存第三方（火山引擎）返回的实际 token 消耗

ALTER TABLE `media_jobs`
  ADD COLUMN `provider_tokens` BIGINT UNSIGNED DEFAULT NULL
    COMMENT '第三方实际消耗的 tokens（如火山引擎 completion_tokens）'
  AFTER `points_refunded`;

-- ============================================================
-- 合并日志表迁移：proxy_request_logs 并入 proxy_logs，DROP 原表
--
-- 背景：计费结算 + 请求/响应审计合并为单表 proxy_logs。
--   - recordRequestLogStart 建行（status='processing'，审计字段）；
--   - 结算回填 / 完成回填均为部分 UPDATE（列集不相交，避免并发整行覆盖）；
--   - billing_detail 为该请求计费多行明细（tokens 消耗 + 各维度费用，\n 拼接）。
--
-- 前提：本次迁移在表为空时执行（无数据迁移需求）。生产环境如已有数据，
--       需自行评估按 request_id 关联迁移，或先清空旧审计表再执行。
-- 目标库：pt_carpool（dev / 生产 CN / 生产 INTL 同结构）
-- 执行：mysql -uroot -p... pt_carpool < merge_proxy_logs.sql
-- ============================================================

-- 1. proxy_logs 增加审计列（原 proxy_request_logs 并入）与 billing_detail 列
ALTER TABLE `proxy_logs`
  ADD COLUMN `request_method` varchar(10) DEFAULT 'POST' AFTER `package_name`,
  ADD COLUMN `request_path` varchar(255) DEFAULT '/v1/chat/completions' AFTER `request_method`,
  ADD COLUMN `request_headers` json DEFAULT NULL AFTER `request_path`,
  ADD COLUMN `request_body` longtext AFTER `request_headers`,
  ADD COLUMN `request_size_bytes` int unsigned DEFAULT '0' AFTER `request_body`,
  ADD COLUMN `response_status` smallint DEFAULT NULL AFTER `request_size_bytes`,
  ADD COLUMN `response_headers` json DEFAULT NULL AFTER `response_status`,
  ADD COLUMN `response_body` longtext AFTER `response_headers`,
  ADD COLUMN `response_size_bytes` int unsigned DEFAULT '0' AFTER `response_body`,
  ADD COLUMN `is_stream` tinyint unsigned DEFAULT '0' AFTER `response_size_bytes`,
  ADD COLUMN `stream_chunks` int unsigned DEFAULT '0' AFTER `is_stream`,
  ADD COLUMN `first_chunk_latency_ms` int unsigned DEFAULT '0' AFTER `stream_chunks`,
  ADD COLUMN `total_latency_ms` int unsigned DEFAULT '0' AFTER `first_chunk_latency_ms`,
  ADD COLUMN `total_tokens` int unsigned DEFAULT '0' AFTER `total_latency_ms`,
  ADD COLUMN `cost_points` bigint DEFAULT '0' AFTER `total_tokens`,
  ADD COLUMN `error_code` varchar(50) DEFAULT NULL AFTER `cost_points`,
  ADD COLUMN `error_message` text AFTER `error_code`,
  ADD COLUMN `client_ip` varchar(45) DEFAULT NULL AFTER `error_message`,
  ADD COLUMN `user_agent` varchar(500) DEFAULT NULL AFTER `client_ip`,
  ADD COLUMN `completed_at` datetime NULL DEFAULT NULL AFTER `user_agent`,
  ADD COLUMN `billing_detail` text COMMENT '计费多行明细（tokens 消耗 + 各维度费用，\\n 拼接）' AFTER `completed_at`,
  ADD KEY `idx_logs_request_id` (`request_id`);

-- 2. 删除旧审计表（数据已由前序步骤并入 proxy_logs；本迁移在空表时执行）
DROP TABLE IF EXISTS `proxy_request_logs`;

-- 网关用到的表结构复制（源: silievo_dev, 目标: pt_carpool）
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS=0;

DROP TABLE IF EXISTS `audio_transcription_tasks`;
DROP TABLE IF EXISTS `exchange_rates`;
DROP TABLE IF EXISTS `material_assets`;
DROP TABLE IF EXISTS `material_collections`;
DROP TABLE IF EXISTS `model_library`;
DROP TABLE IF EXISTS `model_price_tiers`;
DROP TABLE IF EXISTS `model_prices`;
DROP TABLE IF EXISTS `endpoint`;
DROP TABLE IF EXISTS `packages`;
DROP TABLE IF EXISTS `price_tier_time_ranges`;
DROP TABLE IF EXISTS `price_tier_usage_ranges`;
DROP TABLE IF EXISTS `provider_capabilities`;
DROP TABLE IF EXISTS `proxy_channel_models`;
DROP TABLE IF EXISTS `proxy_channel_tokens`;
DROP TABLE IF EXISTS `proxy_channels`;
DROP TABLE IF EXISTS `proxy_logs`;
DROP TABLE IF EXISTS `proxy_request_logs`;
DROP TABLE IF EXISTS `proxy_tokens`;
DROP TABLE IF EXISTS `unified_stats`;
DROP TABLE IF EXISTS `user_model_discounts`;
DROP TABLE IF EXISTS `user_model_permissions`;
DROP TABLE IF EXISTS `user_packages`;
DROP TABLE IF EXISTS `user_usage_stats`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `video_generation_tasks`;

CREATE TABLE `audio_transcription_tasks` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `task_id` varchar(128) NOT NULL COMMENT '涓婃父浠诲姟ID锛圖ashScope task_id锛',
  `request_id` varchar(64) NOT NULL COMMENT '缃戝叧璇锋眰ID锛堜綑棰濋?鍗?key锛',
  `user_id` bigint DEFAULT NULL,
  `token_id` bigint DEFAULT NULL,
  `token_name` varchar(128) DEFAULT NULL,
  `channel_id` bigint DEFAULT NULL,
  `channel_name` varchar(64) DEFAULT NULL,
  `model` varchar(128) NOT NULL COMMENT '瀹㈡埛绔?師濮嬪畬鏁存ā鍨婭D锛堝惈娓犻亾鍓嶇紑锛',
  `upstream_model` varchar(128) DEFAULT NULL,
  `routing_json` text COMMENT 'RoutingResult 蹇?収 JSON',
  `audio_url` varchar(2048) DEFAULT NULL COMMENT 'OSS 24h绛惧悕URL锛堟彁浜ゆ椂缁欎笂娓告媺鍙栵紱钀藉簱宸叉埅鏂??鍚?query锛',
  `oss_key` varchar(512) DEFAULT NULL COMMENT 'OSS 瀵硅薄 key锛堝?璐?娓呯悊锛',
  `audio_mime` varchar(64) DEFAULT NULL,
  `audio_size` bigint DEFAULT NULL,
  `duration_seconds` int DEFAULT NULL COMMENT '闊抽?鏃堕暱锛堢?锛屾彁浜ゆ椂鏈嶅姟绔?В鏋愶紝缁撶畻鐢?級',
  `text` text COMMENT '杞?啓缁撴灉锛圥oller 鍐欏洖锛',
  `language` varchar(32) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/PROCESSING/SUCCEEDED/FAILED/TIMEOUT',
  `error_code` varchar(64) DEFAULT NULL,
  `error_message` varchar(2000) DEFAULT NULL,
  `price_markup` decimal(10,4) DEFAULT NULL,
  `quota_consumed` bigint DEFAULT NULL,
  `billing_status` varchar(16) NOT NULL DEFAULT 'pending' COMMENT 'pending/billed/overdue',
  `billed_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `submitted_at` datetime NOT NULL,
  `completed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_task_id` (`task_id`),
  KEY `idx_status_time` (`status`,`created_at`),
  KEY `idx_request_id` (`request_id`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='ASR 璇?煶杞?啓寮傛?浠诲姟琛';

CREATE TABLE `exchange_rates` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `from_currency` varchar(3) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '源币种，如 USD',
  `to_currency` varchar(3) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '目标币种，如 CNY',
  `rate` decimal(10,6) NOT NULL COMMENT '汇率',
  `source` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT 'manual' COMMENT '汇率来源：manual, api',
  `status` tinyint DEFAULT '1' COMMENT '0=禁用,1=启用',
  `valid_from` datetime DEFAULT CURRENT_TIMESTAMP,
  `valid_until` datetime DEFAULT NULL COMMENT '过期时间',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_currency_pair` (`from_currency`,`to_currency`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='汇率表';

CREATE TABLE `material_assets` (
  `id` varchar(128) NOT NULL COMMENT '鏂硅垷绱犳潗璧勪骇ID asset-xxx锛堜富閿?級',
  `user_id` int unsigned NOT NULL COMMENT '骞冲彴鐢ㄦ埛ID锛坱oken.userId锛夆? 鎴戞柟澶氱?鎴烽殧绂',
  `token_id` int unsigned NOT NULL COMMENT '涓婁紶鎵?敤 API Key id 鈥?鎴戞柟瀹¤?',
  `group_id` varchar(128) NOT NULL COMMENT '鎵?睘鏂硅垷绱犳潗璧勪骇缁処D锛?material_collections.id锛',
  `name` varchar(64) DEFAULT NULL COMMENT '鏂硅垷 Name锛堚墹64锛屼粎ListAssets鎼滅储鐢?級',
  `asset_type` varchar(16) NOT NULL COMMENT '鏂硅垷 AssetType锛欼mage/Video/Audio',
  `status` varchar(16) NOT NULL DEFAULT 'Processing' COMMENT '鏂硅垷 Status锛歅rocessing/Active/Failed',
  `moderation` varchar(64) DEFAULT NULL COMMENT '鏂硅垷 Moderation 瀹℃牳缁撴灉',
  `error_message` varchar(500) DEFAULT NULL COMMENT '鏂硅垷 Error 澶辫触鍘熷洜',
  `project_name` varchar(64) DEFAULT 'default' COMMENT '鏂硅垷 ProjectName',
  `last_inference_time` varchar(32) DEFAULT NULL COMMENT '最近一次被提交至视频生成任务的时间（方舟LastInferenceTime，RFC3339）',
  `url` varchar(1024) DEFAULT NULL COMMENT '鎴戞柟TOS绋冲畾URL锛堥?瑙?涓嬭浇鐢?紱鏂硅垷URL浠?2h杩囨湡锛',
  `object_key` varchar(512) DEFAULT NULL COMMENT '鎴戞柟TOS瀵硅薄key锛堝垹闄ゆ椂娓呯悊瀵硅薄锛',
  `mime` varchar(64) DEFAULT NULL COMMENT '鎴戞柟妫?祴鐨凪IME锛堢被鍨嬫牎楠岃拷韪?級',
  `size_bytes` bigint unsigned NOT NULL DEFAULT '0' COMMENT '鎴戞柟鏂囦欢澶у皬锛堟牎楠?瀹¤?锛',
  `is_deleted` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0=姝ｅ父 1=杞?垹闄',
  `deleted_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_group` (`group_id`,`is_deleted`,`created_at` DESC),
  KEY `idx_status` (`status`),
  KEY `idx_user_created` (`user_id`,`is_deleted`,`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='绱犳潗璧勪骇锛堥暅鍍忔柟鑸烝sset锛宨d=鏂硅垷asset id锛';

CREATE TABLE `material_collections` (
  `id` varchar(128) NOT NULL COMMENT '鏂硅垷绱犳潗璧勪骇缁処D group-xxx锛堜富閿?級',
  `user_id` int unsigned NOT NULL COMMENT '骞冲彴鐢ㄦ埛ID锛坱oken.userId锛夆? 鎴戞柟澶氱?鎴烽殧绂',
  `token_id` int unsigned NOT NULL COMMENT '鍒涘缓鎵?敤 API Key id 鈥?鎴戞柟瀹¤?',
  `name` varchar(64) NOT NULL COMMENT '鏂硅垷 Name锛堚墹64锛',
  `description` varchar(300) DEFAULT NULL COMMENT '鏂硅垷 Description锛堚墹300锛',
  `group_type` varchar(16) DEFAULT 'AIGC' COMMENT '鏂硅垷 GroupType',
  `project_name` varchar(64) DEFAULT 'default' COMMENT '鏂硅垷 ProjectName',
  `is_deleted` tinyint unsigned NOT NULL DEFAULT '0' COMMENT '0=姝ｅ父 1=杞?垹闄',
  `deleted_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_created` (`user_id`,`is_deleted`,`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='绱犳潗璧勪骇缁勶紙闀滃儚鏂硅垷AssetGroup锛宨d=鏂硅垷group id锛';

-- 注：model_channel_configs 表已废弃删除（模型调用 URI 直接由网关在 proxy_channel_models/模型库上解析），不再建表

CREATE TABLE `model_library` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `model_id` varchar(100) NOT NULL COMMENT '模型唯一标识',
  `display_name` varchar(100) NOT NULL COMMENT '显示名称',
  `description` text COMMENT '模型描述',
  `category` varchar(30) NOT NULL COMMENT '分类：llm/image/video/audio/embedding/reasoning',
  `provider` varchar(30) NOT NULL COMMENT '厂商',
  `capabilities` json DEFAULT NULL COMMENT '能力数组',
  `context_window` int unsigned DEFAULT NULL COMMENT '上下文窗口',
  `max_output_tokens` int unsigned DEFAULT NULL COMMENT '最大输出token数',
  `training_data_cutoff` date DEFAULT NULL COMMENT '训练数据截止日期',
  `status` tinyint unsigned DEFAULT '1' COMMENT '0=禁用/1=启用/2=维护中',
  `is_visible` tinyint unsigned DEFAULT '1' COMMENT '是否对用户可见',
  `is_hot` tinyint unsigned DEFAULT '0' COMMENT '是否热门（卡片角标）',
  `is_new` tinyint unsigned DEFAULT '0' COMMENT '是否新模型（角标）',
  `badge_text` varchar(20) DEFAULT NULL COMMENT '自定义角标文本，如 5折/限免',
  `badge_color` varchar(20) DEFAULT NULL COMMENT '角标颜色（CSS 色值）',
  `sort_order` int DEFAULT '0' COMMENT '排序',
  `icon_url` varchar(500) DEFAULT NULL COMMENT '图标URL',
  `doc_url` varchar(500) DEFAULT NULL COMMENT '文档链接',
  `metadata` json DEFAULT NULL COMMENT '扩展元数据',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `model_id` (`model_id`),
  KEY `idx_model_category_provider` (`category`,`provider`),
  KEY `idx_model_status_visible` (`status`,`is_visible`),
  FULLTEXT KEY `ft_model_search` (`display_name`,`description`)
) ENGINE=InnoDB AUTO_INCREMENT=88 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='模型库表';

CREATE TABLE `model_price_tiers` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `price_id` bigint NOT NULL COMMENT '关联 model_prices 表',
  `tier_type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'time_of_day, usage_tier, combined',
  `tier_name` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '配置名称，如 peak_hours, high_volume_discount',
  `priority` int DEFAULT '0' COMMENT '优先级，高优先级覆盖低优先级',
  `status` tinyint DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_price_id` (`price_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='分层定价配置表';

CREATE TABLE `model_prices` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `model_id` varchar(100) NOT NULL COMMENT '模型ID',
  `endpoint_type` varchar(40) DEFAULT NULL COMMENT '端点维度（NULL=适用所有端点）',
  `token_group_code` varchar(40) NOT NULL DEFAULT 'default' COMMENT '令牌组（关联 model_token_groups.code）',
  `is_auto_derived` tinyint unsigned DEFAULT '0' COMMENT '0=管理员手填 / 1=按倍率自动推算',
  `price_type` varchar(20) NOT NULL DEFAULT 'platform' COMMENT 'official/platform/promotional',
  `billing_mode` varchar(20) NOT NULL DEFAULT 'token' COMMENT 'token/image/video_second/audio_minute/flat',
  `base_price` decimal(10,6) DEFAULT '0.000000' COMMENT '基础价格',
  `billing_params` json DEFAULT NULL COMMENT '计费参数',
  `tier_config` json DEFAULT NULL COMMENT '阶梯定价',
  `official_price` json DEFAULT NULL COMMENT '官方价格对比',
  `valid_from` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `valid_until` timestamp NULL DEFAULT NULL,
  `status` tinyint unsigned DEFAULT '1',
  `is_promotional` tinyint unsigned DEFAULT '0',
  `description` varchar(500) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `channel_id` int DEFAULT NULL,
  `channel_name` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_price_model_type` (`model_id`,`price_type`),
  KEY `idx_price_valid_period` (`valid_from`,`valid_until`),
  KEY `idx_price_model_endpoint_group` (`model_id`,`endpoint_type`,`token_group_code`,`price_type`),
  CONSTRAINT `model_prices_ibfk_1` FOREIGN KEY (`model_id`) REFERENCES `model_library` (`model_id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=143 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='模型价格表';

CREATE TABLE `endpoint` (
  `id` int NOT NULL AUTO_INCREMENT,
  `endpoint_name` varchar(100) NOT NULL COMMENT '端点名称',
  `path` varchar(255) NOT NULL COMMENT 'API路径',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=23 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `packages` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '套餐ID',
  `name` varchar(100) NOT NULL COMMENT '套餐名称，如"普通会员套餐"',
  `description` varchar(500) DEFAULT NULL COMMENT '套餐描述',
  `models` json NOT NULL COMMENT '模型折扣配置（JSON数组）',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '状态：0=禁用，1=启用',
  `sort_order` int DEFAULT '0' COMMENT '排序权重，越小越靠前',
  `start_at` datetime DEFAULT NULL COMMENT '生效开始时间，NULL表示立即生效',
  `end_at` datetime DEFAULT NULL COMMENT '生效结束时间，NULL表示永久有效',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted_at` datetime DEFAULT NULL COMMENT '软删除时间',
  `min_consumption` decimal(12,2) NOT NULL DEFAULT '0.00' COMMENT '最低累计消费额度（元）',
  `max_consumption` decimal(12,2) DEFAULT NULL COMMENT '最高累计消费额度（元），NULL=不限制',
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`),
  KEY `idx_sort_order` (`sort_order`),
  KEY `idx_start_end` (`start_at`,`end_at`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='套餐表';

CREATE TABLE `price_tier_time_ranges` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `tier_id` bigint NOT NULL,
  `tier_name` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '时段名称，如 peak, off_peak',
  `time_start` time NOT NULL COMMENT '时段开始时间',
  `time_end` time NOT NULL COMMENT '时段结束时间',
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT 'Asia/Shanghai' COMMENT '时区',
  `price_multiplier` decimal(4,2) NOT NULL DEFAULT '1.00' COMMENT '价格倍率',
  `days_of_week` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT '1,2,3,4,5,6,7' COMMENT '生效星期（1=周一，逗号分隔）',
  `priority` int DEFAULT '0' COMMENT '同配置下优先级',
  `price_overrides` json DEFAULT NULL COMMENT 'Busy/idle absolute price overrides',
  PRIMARY KEY (`id`),
  KEY `idx_tier_id` (`tier_id`)
) ENGINE=InnoDB AUTO_INCREMENT=20 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='分时段定价明细表';

CREATE TABLE `price_tier_usage_ranges` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `tier_id` bigint NOT NULL,
  `tier_level` int NOT NULL COMMENT '阶梯等级，1=第一阶梯',
  `min_usage` bigint NOT NULL COMMENT '阶梯起始用量（包含）',
  `max_usage` bigint DEFAULT NULL COMMENT '阶梯结束用量（NULL表示无上限）',
  `price_discount` decimal(4,2) DEFAULT '1.00' COMMENT '价格折扣（0.8=8折）',
  `price_override` decimal(20,10) DEFAULT NULL COMMENT '覆盖单价（直接指定新价格，优先级高于折扣）',
  PRIMARY KEY (`id`),
  KEY `idx_tier_id` (`tier_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用量阶梯定价明细表';

CREATE TABLE `provider_capabilities` (
  `id` int NOT NULL AUTO_INCREMENT,
  `provider_alias` varchar(64) NOT NULL COMMENT 'provider_alias，路由 key（绑定行 JSON 用）',
  `domain` varchar(16) NOT NULL COMMENT '能力域: chat/image/video',
  `name` varchar(64) NOT NULL COMMENT '后台展示名',
  `class_name` varchar(255) NOT NULL COMMENT 'Adapter 实现类全限定名',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_provider_alias` (`provider_alias`)
) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Adapter 能力清单（网关枚举启动同步，admin_backend 直读）';

CREATE TABLE `proxy_channel_models` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `channel_id` int NOT NULL COMMENT '渠道ID',
  `model_id` varchar(100) NOT NULL COMMENT '模型ID',
  `provider_capability` json DEFAULT NULL COMMENT '该模型在此渠道绑定的 Adapter 能力快照：{"provider_alias":"...","domain":"chat/image/video","class_name":"..."}；NULL=未绑定（启动自动回填）',
  `use_endpoint_id` int DEFAULT NULL COMMENT '关联的端点模板ID（endpoint.id）；NULL=未绑定',
  `priority` int DEFAULT '0' COMMENT '优先级',
  `markup` decimal(6,4) NOT NULL DEFAULT '1.0000' COMMENT '加价乘数，1.0=不加，1.1=+10%',
  `is_enabled` tinyint unsigned DEFAULT '1' COMMENT '是否启用',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_channel_model` (`channel_id`,`model_id`),
  KEY `idx_cm_model` (`model_id`),
  KEY `idx_cm_endpoint` (`use_endpoint_id`),
  KEY `idx_cm_enabled` (`is_enabled`),
  CONSTRAINT `proxy_channel_models_ibfk_1` FOREIGN KEY (`channel_id`) REFERENCES `proxy_channels` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=89 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='渠道-模型关联表';

CREATE TABLE `proxy_channel_tokens` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `channel_id` int NOT NULL COMMENT '所属渠道ID',
  `name` varchar(100) DEFAULT NULL COMMENT 'Token名称',
  `api_key_encrypted` text NOT NULL COMMENT '加密的API Key',
  `weight` int unsigned DEFAULT '1' COMMENT '权重',
  `current_usage` int unsigned DEFAULT '0' COMMENT '当前使用次数',
  `status` tinyint unsigned DEFAULT '1' COMMENT '0=禁用/1=启用',
  `total_requests` bigint unsigned DEFAULT '0' COMMENT '累计请求数',
  `success_count` bigint unsigned DEFAULT '0' COMMENT '成功次数',
  `error_count` bigint unsigned DEFAULT '0' COMMENT '失败次数',
  `last_used_at` timestamp NULL DEFAULT NULL,
  `consecutive_errors` int unsigned DEFAULT '0',
  `auto_disabled` tinyint unsigned DEFAULT '0',
  `auto_disabled_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ct_channel_id` (`channel_id`),
  KEY `idx_ct_status` (`status`),
  KEY `idx_ct_auto_disabled` (`auto_disabled`),
  KEY `idx_ct_usage` (`current_usage`),
  CONSTRAINT `proxy_channel_tokens_ibfk_1` FOREIGN KEY (`channel_id`) REFERENCES `proxy_channels` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=53 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='渠道-Token关联表（支持多Token负载均衡）';

CREATE TABLE `proxy_channels` (
  `id` int NOT NULL AUTO_INCREMENT,
  `channel_code` varchar(32) DEFAULT NULL COMMENT '渠道代码（如 huawei, ali, openai 等）',
  `name` varchar(255) NOT NULL,
  `type` varchar(50) NOT NULL DEFAULT 'openai',
  `base_url` varchar(255) NOT NULL,
  `api_key` text NOT NULL,
  `token_lb_strategy` varchar(20) DEFAULT 'round_robin',
  `status` tinyint DEFAULT '1',
  `priority` int DEFAULT '0',
  `weight` int DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `param_mappings` json DEFAULT NULL COMMENT '参数映射配置，如 {"messages": "input"} 表示将 messages 参数重命名为 input',
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_channel_code` (`channel_code`)
) ENGINE=InnoDB AUTO_INCREMENT=27 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ============================================================
-- proxy_logs：结算 + 请求/响应审计 合并表
-- （原 proxy_request_logs 已并入本表，DROP 原表）
-- 说明：
--   - recordRequestLogStart 建行（status='processing'，审计字段）；
--   - 结算回填/完成回填均为部分 UPDATE（列集不相交，避免并发整行覆盖）；
--   - billing_detail 为该请求计费多行明细（tokens 消耗 + 各维度费用，\n 拼接）。
-- ============================================================
CREATE TABLE `proxy_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL DEFAULT '0',
  `token_id` int DEFAULT NULL,
  `token_name` varchar(255) DEFAULT NULL,
  `channel_id` int DEFAULT NULL,
  `request_id` varchar(36) DEFAULT NULL,
  `channel_name` varchar(255) DEFAULT NULL,
  `model` varchar(100) DEFAULT NULL,
  `prompt_tokens` int DEFAULT '0',
  `completion_tokens` int DEFAULT '0',
  `quota_consumed` bigint DEFAULT '0',
  `latency_ms` int DEFAULT '0',
  `status` varchar(20) DEFAULT 'processing',
  `error_msg` text,
  `is_thinking` tinyint DEFAULT '0',
  `price_markup` decimal(10,4) DEFAULT '1.0000',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `aborted` tinyint unsigned DEFAULT '0',
  `package_id` int unsigned DEFAULT NULL COMMENT '使用的套餐ID',
  `package_name` varchar(100) DEFAULT NULL COMMENT '使用的套餐名称',
  -- ====== 审计字段（原 proxy_request_logs 并入） ======
  `request_method` varchar(10) DEFAULT 'POST',
  `request_path` varchar(255) DEFAULT '/v1/chat/completions',
  `request_headers` json DEFAULT NULL,
  `request_body` longtext,
  `request_size_bytes` int unsigned DEFAULT '0',
  `response_status` smallint DEFAULT NULL,
  `response_headers` json DEFAULT NULL,
  `response_body` longtext,
  `response_size_bytes` int unsigned DEFAULT '0',
  `is_stream` tinyint unsigned DEFAULT '0',
  `stream_chunks` int unsigned DEFAULT '0',
  `first_chunk_latency_ms` int unsigned DEFAULT '0',
  `total_latency_ms` int unsigned DEFAULT '0',
  `total_tokens` int unsigned DEFAULT '0',
  `cost_points` bigint DEFAULT '0',
  `error_code` varchar(50) DEFAULT NULL,
  `error_message` text,
  `client_ip` varchar(45) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  `completed_at` datetime NULL DEFAULT NULL,
  `billing_detail` text COMMENT '计费多行明细（tokens 消耗 + 各维度费用，\\n 拼接）',
  PRIMARY KEY (`id`),
  KEY `idx_logs_created_at` (`created_at`),
  KEY `idx_logs_token_id` (`token_id`),
  KEY `idx_logs_channel_id` (`channel_id`),
  KEY `idx_logs_model` (`model`),
  KEY `idx_logs_status` (`status`),
  KEY `proxy_logs_created_at_IDX` (`created_at`,`user_id`) USING BTREE,
  KEY `idx_package_id` (`package_id`),
  KEY `idx_proxy_logs_latency_stats` (`created_at`,`latency_ms`),
  KEY `idx_logs_request_id` (`request_id`)
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `proxy_tokens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int unsigned NOT NULL DEFAULT '1',
  `name` varchar(255) NOT NULL,
  `key` varchar(191) NOT NULL,
  `token_group_code` varchar(40) NOT NULL DEFAULT 'default' COMMENT '所属令牌组（关联 model_token_groups.code）',
  `models` text,
  `quota` bigint DEFAULT '0',
  `used_quota` bigint DEFAULT '0',
  `remain_quota` bigint DEFAULT '0',
  `start_at` datetime DEFAULT NULL COMMENT 'Token生效开始时间',
  `expired_at` datetime DEFAULT NULL,
  `status` tinyint DEFAULT '1',
  `channel_id` int DEFAULT NULL,
  `price_markup` decimal(10,4) DEFAULT '1.0000',
  `api_key` varchar(255) DEFAULT '',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `rate_limit_rpm` int unsigned NOT NULL DEFAULT '10',
  `gift_quota` int NOT NULL DEFAULT '0' COMMENT '赠送额度(单位: points, 1元=100000)',
  PRIMARY KEY (`id`),
  UNIQUE KEY `key` (`key`),
  KEY `idx_token_user_id` (`user_id`),
  KEY `idx_token_group_code` (`token_group_code`)
) ENGINE=InnoDB AUTO_INCREMENT=56 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `unified_stats` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `stat_date` date NOT NULL COMMENT '统计日期',
  `stat_hour` tinyint unsigned DEFAULT NULL COMMENT '统计小时(0-23)，NULL表示日统计',
  `dim_type` varchar(20) NOT NULL COMMENT '维度类型: global/channel/token/model/user/composite',
  `dim1_key` varchar(50) NOT NULL COMMENT '一级维度键: "global"/"ch:1"/"tk:1001"/"md:gpt-4"',
  `dim2_key` varchar(50) NOT NULL DEFAULT '' COMMENT '二级维度键',
  `metric_name` varchar(50) NOT NULL COMMENT '指标名: requests/quota/latency_sum/online',
  `metric_value` double NOT NULL DEFAULT '0' COMMENT '指标值',
  `meta_json` json DEFAULT NULL COMMENT '额外元数据: {"channel_name":"阿里云","model":"gpt-4"}',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_metric_time` (`dim_type`,`dim1_key`,`dim2_key`,`metric_name`,`stat_date`,`stat_hour`),
  KEY `idx_date_dim` (`stat_date`,`dim_type`,`dim1_key`),
  KEY `idx_dim2` (`dim_type`,`dim2_key`,`stat_date`),
  KEY `idx_metric` (`stat_date`,`metric_name`)
) ENGINE=InnoDB AUTO_INCREMENT=776840 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `user_model_discounts` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL COMMENT '关联用户ID',
  `models` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联模型ID（model_library表）',
  `discount_type` enum('PERCENTAGE','FIXED_AMOUNT','OVERRIDE_PRICE') NOT NULL DEFAULT 'PERCENTAGE' COMMENT '优惠类型：百分比折扣/固定金额减免/覆盖价格',
  `discount_value` decimal(10,4) NOT NULL COMMENT '优惠值：百分比折扣填0.8表示8折，固定金额填减免金额，覆盖价格填新价格',
  `start_time` datetime DEFAULT NULL COMMENT '生效开始时间，NULL表示立即生效',
  `end_time` datetime DEFAULT NULL COMMENT '生效结束时间，NULL表示永久生效',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '状态：1启用 0禁用',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` bigint DEFAULT NULL COMMENT '创建人',
  `updated_by` bigint DEFAULT NULL COMMENT '更新人',
  `remark` varchar(500) DEFAULT NULL COMMENT '备注',
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_status` (`status`),
  KEY `idx_time_range` (`start_time`,`end_time`)
) ENGINE=InnoDB AUTO_INCREMENT=24 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户模型优惠配置表';

CREATE TABLE `user_model_permissions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL COMMENT '关联用户ID',
  `models` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '关联模型ID（model_library表），NULL表示所有模型',
  `permission_type` enum('WHITELIST','BLACKLIST') NOT NULL DEFAULT 'WHITELIST' COMMENT '权限类型：白名单/黑名单',
  `start_time` datetime DEFAULT NULL COMMENT '生效开始时间，NULL表示立即生效',
  `end_time` datetime DEFAULT NULL COMMENT '生效结束时间，NULL表示永久生效',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '状态：1启用 0禁用',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` bigint DEFAULT NULL COMMENT '创建人',
  `updated_by` bigint DEFAULT NULL COMMENT '更新人',
  `remark` varchar(500) DEFAULT NULL COMMENT '备注',
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_status` (`status`),
  KEY `idx_time_range` (`start_time`,`end_time`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户模型权限配置表';

CREATE TABLE `user_packages` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '绑定ID',
  `user_id` int unsigned NOT NULL COMMENT '用户ID',
  `package_id` int unsigned NOT NULL COMMENT '套餐ID',
  `package_name` varchar(100) NOT NULL COMMENT '套餐名称（冗余字段，避免关联查询）',
  `assigned_by` int unsigned DEFAULT NULL COMMENT '分配人ID（管理员ID）',
  `assigned_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '分配时间',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user` (`user_id`),
  KEY `idx_package_id` (`package_id`),
  KEY `idx_assigned_by` (`assigned_by`),
  CONSTRAINT `user_packages_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `user_packages_ibfk_2` FOREIGN KEY (`package_id`) REFERENCES `packages` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户套餐绑定表（一个用户只能绑定一个套餐）';

CREATE TABLE `user_usage_stats` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `stat_period` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '统计周期：daily, monthly',
  `stat_date` date NOT NULL COMMENT '统计日期',
  `model_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `total_tokens` bigint DEFAULT '0' COMMENT '累计tokens',
  `total_requests` int DEFAULT '0' COMMENT '累计请求数',
  `total_cost_usd` decimal(20,10) DEFAULT '0.0000000000' COMMENT '累计费用',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_period_model` (`user_id`,`stat_period`,`stat_date`,`model_id`),
  KEY `idx_user_period` (`user_id`,`stat_period`,`stat_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户用量统计表';

-- 注：users 表已废弃（2026-08 迁移 migrate-remove-users.ts 中 DROP）。
-- 用户统一存 pt_carpool.pt_users，余额列亦已迁入 pt_users。
-- 原表结构（AUTO_INCREMENT=2009）见历史提交，不再在此建。

CREATE TABLE `video_generation_tasks` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `task_id` varchar(64) NOT NULL COMMENT '涓婃父浠诲姟ID锛堝?闃块噷浜戣繑鍥炵殑task_id锛',
  `request_id` varchar(64) DEFAULT NULL COMMENT '鏈??璇锋眰鐨剅equest_id',
  `user_id` int unsigned NOT NULL COMMENT '鐢ㄦ埛ID',
  `token_id` int unsigned NOT NULL COMMENT '浣跨敤鐨凾oken ID',
  `token_name` varchar(255) DEFAULT NULL COMMENT 'Token鍚嶇О锛堝揩鐓э級',
  `channel_id` int unsigned DEFAULT NULL COMMENT '娓犻亾ID',
  `channel_name` varchar(255) DEFAULT NULL COMMENT '娓犻亾鍚嶇О锛堝揩鐓э級',
  `model` varchar(100) NOT NULL COMMENT '妯″瀷ID锛屽?happyhorse-1.0-r2v',
  `upstream_model` varchar(128) DEFAULT NULL COMMENT '上游纯模型ID（如 happyhorse-1.0-t2v）',
  `routing_json` text COMMENT 'RoutingResult 快照（channelCode/channelId/upstreamModel/modelId/pureModelId/hasChannelPrefix）',
  `video_mode` enum('text2video','image2video','reference2video','first_last_frame','video2video') NOT NULL COMMENT '视频生成模式',
  `prompt` text COMMENT '鎻愮ず璇',
  `input_resources` json DEFAULT NULL COMMENT '杈撳叆璧勬簮锛歿"images": [...], "reference_image": ...}',
  `resolution` varchar(20) DEFAULT '720P' COMMENT '鍒嗚鲸鐜囷細720P/1080P',
  `aspect_ratio` varchar(10) DEFAULT '16:9' COMMENT '瀹介珮姣旓細16:9/9:16/1:1',
  `duration` int DEFAULT '5' COMMENT '鏃堕暱锛堢?锛',
  `status` enum('PENDING','PROCESSING','SUCCEEDED','FAILED','TIMEOUT') DEFAULT 'PENDING' COMMENT '浠诲姟鐘舵?',
  `video_url` varchar(1024) DEFAULT NULL COMMENT '鐢熸垚鐨勮?棰慤RL锛堥樋閲屼簯OSS閾炬帴锛',
  `cover_url` varchar(1024) DEFAULT NULL COMMENT '瑙嗛?灏侀潰URL',
  `completion_tokens` bigint DEFAULT NULL COMMENT '生成视频消耗的completion_tokens(Seedance按token计费)',
  `error_code` varchar(50) DEFAULT NULL COMMENT '閿欒?鐮',
  `error_message` text COMMENT '閿欒?淇℃伅',
  `price_markup` decimal(5,4) DEFAULT '1.0000' COMMENT '浠锋牸鍔犳垚',
  `quota_consumed` bigint DEFAULT '0' COMMENT '娑堣?鐨勯?搴',
  `billing_status` enum('pending','billed','free','overdue') DEFAULT 'pending',
  `billed_at` timestamp NULL DEFAULT NULL COMMENT '璁¤垂鏃堕棿',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '鍒涘缓鏃堕棿',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '鏇存柊鏃堕棿',
  `submitted_at` timestamp NULL DEFAULT NULL COMMENT '鎻愪氦鍒颁笂娓哥殑鏃堕棿',
  `completed_at` timestamp NULL DEFAULT NULL COMMENT '瀹屾垚鏃堕棿锛堟垚鍔熸垨澶辫触锛',
  PRIMARY KEY (`id`),
  UNIQUE KEY `task_id` (`task_id`),
  KEY `idx_user_status` (`user_id`,`status`),
  KEY `idx_token` (`token_id`),
  KEY `idx_task_id` (`task_id`),
  KEY `idx_status_created` (`status`,`created_at`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=59 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='瑙嗛?鐢熸垚浠诲姟琛';

SET FOREIGN_KEY_CHECKS=1;

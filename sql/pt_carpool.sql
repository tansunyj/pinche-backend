-- MySQL dump 10.13  Distrib 8.0.41, for Win64 (x86_64)
--
-- Host: localhost    Database: pt_carpool
-- ------------------------------------------------------
-- Server version	8.0.41

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `endpoint`
--

DROP TABLE IF EXISTS `endpoint`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `endpoint` (
  `id` int NOT NULL AUTO_INCREMENT,
  `endpoint_name` varchar(100) NOT NULL COMMENT '端点名称',
  `path` varchar(255) NOT NULL COMMENT 'API路径',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `endpoint`
--

--
-- Table structure for table `model_library`
--

DROP TABLE IF EXISTS `model_library`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=95 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='模型库表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `model_library`
--


--
-- Table structure for table `model_price_tiers`
--

DROP TABLE IF EXISTS `model_price_tiers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='分层定价配置表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `model_price_tiers`
--



--
-- Table structure for table `model_prices`
--

DROP TABLE IF EXISTS `model_prices`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='模型价格表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `model_prices`
--



--
-- Table structure for table `price_tier_time_ranges`
--

DROP TABLE IF EXISTS `price_tier_time_ranges`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='分时段定价明细表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `price_tier_time_ranges`
--


--
-- Table structure for table `provider_capabilities`
--

DROP TABLE IF EXISTS `provider_capabilities`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Adapter 能力清单（网关枚举启动同步，admin_backend 直读）';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `provider_capabilities`
--


--
-- Table structure for table `proxy_channel_models`
--

DROP TABLE IF EXISTS `proxy_channel_models`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
  KEY `idx_cm_enabled` (`is_enabled`),
  KEY `idx_cm_endpoint` (`use_endpoint_id`),
  CONSTRAINT `proxy_channel_models_ibfk_1` FOREIGN KEY (`channel_id`) REFERENCES `proxy_channels` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=25 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='渠道-模型关联表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `proxy_channel_models`
--


--
-- Table structure for table `proxy_channel_tokens`
--

DROP TABLE IF EXISTS `proxy_channel_tokens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='渠道-Token关联表（支持多Token负载均衡）';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `proxy_channel_tokens`
--

--
-- Table structure for table `proxy_channels`
--

DROP TABLE IF EXISTS `proxy_channels`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=33 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `proxy_channels`
--


--
-- Table structure for table `proxy_logs`
--

DROP TABLE IF EXISTS `proxy_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
  `status` varchar(20) DEFAULT 'success',
  `error_msg` text,
  `is_thinking` tinyint DEFAULT '0',
  `price_markup` decimal(10,4) DEFAULT '1.0000',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `aborted` tinyint unsigned DEFAULT '0',
  `request_method` varchar(10) DEFAULT 'POST',
  `request_path` varchar(255) DEFAULT '/v1/chat/completions',
  `response_status` smallint DEFAULT NULL,
  `is_stream` tinyint unsigned DEFAULT '0',
  `stream_chunks` int unsigned DEFAULT '0',
  `first_chunk_latency_ms` int unsigned DEFAULT '0',
  `total_tokens` int unsigned DEFAULT '0',
  `client_ip` varchar(45) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `billing_detail` text COMMENT '璁¤垂澶氳?鏄庣粏锛坱okens 娑堣? + 鍚勭淮搴﹁垂鐢?紝\\n 鎷兼帴锛',
  PRIMARY KEY (`id`),
  KEY `idx_logs_created_at` (`created_at`),
  KEY `idx_logs_token_id` (`token_id`),
  KEY `idx_logs_channel_id` (`channel_id`),
  KEY `idx_logs_model` (`model`),
  KEY `idx_logs_status` (`status`),
  KEY `proxy_logs_created_at_IDX` (`created_at`,`user_id`) USING BTREE,
  KEY `idx_proxy_logs_latency_stats` (`created_at`,`latency_ms`),
  KEY `idx_logs_request_id` (`request_id`)
) ENGINE=InnoDB AUTO_INCREMENT=20 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `proxy_logs`
--
--
-- Table structure for table `proxy_tokens`
--

DROP TABLE IF EXISTS `proxy_tokens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `proxy_tokens`
--

--
-- Table structure for table `pt_admins`
--

DROP TABLE IF EXISTS `pt_admins`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_admins` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `username` varchar(50) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` enum('SUPER_ADMIN','OPERATOR') DEFAULT 'OPERATOR',
  `status` enum('ACTIVE','DISABLED') DEFAULT 'ACTIVE',
  `last_login_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='管理员';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_admins`
--

--
-- Table structure for table `pt_audit_logs`
--

DROP TABLE IF EXISTS `pt_audit_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_audit_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `actor_type` varchar(20) DEFAULT NULL COMMENT 'admin / user / system',
  `actor_id` bigint DEFAULT NULL,
  `actor_name` varchar(100) DEFAULT NULL COMMENT 'admin.username 或 user.phone',
  `method` varchar(10) NOT NULL,
  `path` varchar(500) NOT NULL,
  `query` varchar(1000) DEFAULT NULL,
  `status_code` int NOT NULL,
  `request_body` text COMMENT '脱敏+截断',
  `response_body` text COMMENT '脱敏+截断',
  `ip` varchar(64) DEFAULT NULL,
  `user_agent` varchar(500) DEFAULT NULL,
  `duration_ms` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_actor` (`actor_type`,`actor_id`),
  KEY `idx_path` (`path`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='全接口操作审计日志';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_audit_logs`
--

LOCK TABLES `pt_audit_logs` WRITE;
/*!40000 ALTER TABLE `pt_audit_logs` DISABLE KEYS */;
/*!40000 ALTER TABLE `pt_audit_logs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `pt_idempotent_keys`
--

DROP TABLE IF EXISTS `pt_idempotent_keys`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_idempotent_keys` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `biz_type` varchar(50) NOT NULL COMMENT '业务类型：RECHARGE/JOIN_RIDE/OPEN_ACCOUNT/WRITE_DISCOUNT',
  `biz_key` varchar(128) NOT NULL COMMENT '业务唯一键',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_biz` (`biz_type`,`biz_key`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='幂等键';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_idempotent_keys`
--


--
-- Table structure for table `pt_payment_tasks`
--

DROP TABLE IF EXISTS `pt_payment_tasks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_payment_tasks` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `payment_id` bigint NOT NULL COMMENT 'pt_payments.id',
  `order_no` varchar(64) NOT NULL,
  `task_type` enum('CREDIT_BALANCE') DEFAULT 'CREDIT_BALANCE',
  `status` enum('PENDING','PROCESSING','SUCCESS','FAILED') DEFAULT 'PENDING',
  `retry_count` int DEFAULT '0',
  `last_error` varchar(500) DEFAULT NULL,
  `next_retry_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_status_next` (`status`,`next_retry_at`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='充值到账任务队列';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_payment_tasks`
--

--
-- Table structure for table `pt_payments`
--

DROP TABLE IF EXISTS `pt_payments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_payments` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_no` varchar(64) NOT NULL COMMENT '业务订单号',
  `user_id` bigint NOT NULL COMMENT 'pt_users.id',
  `tier_id` bigint DEFAULT NULL COMMENT '充值档位ID',
  `amount_yuan` decimal(10,2) NOT NULL COMMENT '支付金额',
  `quota` bigint NOT NULL COMMENT '对应额度',
  `provider` enum('ALIPAY','WECHAT') DEFAULT 'ALIPAY',
  `status` enum('PENDING','CALLBACK_RECEIVED','PROCESSING','SUCCESS','FAILED','REFUNDED','CLOSED') DEFAULT 'PENDING',
  `out_trade_no` varchar(64) DEFAULT NULL COMMENT '支付宝交易号',
  `refund_no` varchar(64) DEFAULT NULL COMMENT '退款单号',
  `paid_at` datetime DEFAULT NULL COMMENT '支付成功时间',
  `refunded_at` datetime DEFAULT NULL COMMENT '退款时间',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `order_no` (`order_no`),
  UNIQUE KEY `out_trade_no` (`out_trade_no`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_status` (`status`),
  KEY `idx_out_trade_no` (`out_trade_no`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='支付流水';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_payments`
--

--
-- Table structure for table `pt_recharge_tiers`
--

DROP TABLE IF EXISTS `pt_recharge_tiers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_recharge_tiers` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `amount_yuan` decimal(10,2) NOT NULL COMMENT '金额（元）',
  `quota` bigint NOT NULL COMMENT '额度（网关计费单位，1元=100000）',
  `display_order` int DEFAULT '0' COMMENT '显示顺序',
  `enabled` tinyint(1) DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='充值档位';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_recharge_tiers`
--

--
-- Table structure for table `pt_ride_group_models`
--

DROP TABLE IF EXISTS `pt_ride_group_models`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_ride_group_models` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `group_id` bigint NOT NULL COMMENT '所属分组',
  `ride_id` bigint NOT NULL COMMENT '冗余车次ID，用于唯一约束',
  `model_id` varchar(100) NOT NULL COMMENT '模型ID（带渠道前缀，如 aliyun/deepseek-v4-flash）',
  `model_name` varchar(100) DEFAULT NULL COMMENT '模型显示名',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ride_model` (`ride_id`,`model_id`) COMMENT '同一车次内模型不可重复',
  KEY `idx_group_id` (`group_id`),
  CONSTRAINT `pt_ride_group_models_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `pt_ride_groups` (`id`) ON DELETE CASCADE,
  CONSTRAINT `pt_ride_group_models_ibfk_2` FOREIGN KEY (`ride_id`) REFERENCES `pt_rides` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='分组内的模型';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_ride_group_models`
--

--
-- Table structure for table `pt_ride_groups`
--

DROP TABLE IF EXISTS `pt_ride_groups`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_ride_groups` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `ride_id` bigint NOT NULL COMMENT '所属车次',
  `discount_rate` decimal(3,2) NOT NULL COMMENT '该分组折扣率，如 0.60',
  `display_order` int DEFAULT '0' COMMENT '显示顺序',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ride_id` (`ride_id`),
  CONSTRAINT `pt_ride_groups_ibfk_1` FOREIGN KEY (`ride_id`) REFERENCES `pt_rides` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=24 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='车次模型分组';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_ride_groups`
--

--
-- Table structure for table `pt_ride_members`
--

DROP TABLE IF EXISTS `pt_ride_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_ride_members` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `ride_id` bigint NOT NULL,
  `user_id` bigint NOT NULL COMMENT 'pt_users.id',
  `joined_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `total_consumption` bigint DEFAULT '0' COMMENT '该用户在该车次模型上的累计消费额度（用于活跃度回收豁免判断）',
  `last_consumption_at` datetime DEFAULT NULL COMMENT '最后一次消费时间（用于活跃度回收扫描）',
  `kicked_at` datetime DEFAULT NULL COMMENT '被请出时间（活跃度回收）',
  `status` enum('ACTIVE','KICKED') DEFAULT 'ACTIVE' COMMENT '成员状态',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ride_user` (`ride_id`,`user_id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_status_joined` (`status`,`joined_at`),
  CONSTRAINT `pt_ride_members_ibfk_1` FOREIGN KEY (`ride_id`) REFERENCES `pt_rides` (`id`),
  CONSTRAINT `pt_ride_members_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `pt_users` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='上车记录';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_ride_members`
--

--
-- Table structure for table `pt_rides`
--

DROP TABLE IF EXISTS `pt_rides`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_rides` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL COMMENT '车次名称，如"DeepSeek全家桶特惠"',
  `description` varchar(500) DEFAULT NULL COMMENT '车次描述',
  `current_count` int DEFAULT '0' COMMENT '当前人数',
  `min_count` int NOT NULL DEFAULT '1' COMMENT '最低成团人数（达到后车次自动成立）',
  `end_time` datetime DEFAULT NULL COMMENT '车次结束时间（= 上车截止 + 折扣过期，硬门禁）',
  `start_time` datetime DEFAULT NULL COMMENT '车次开始时间（展示用）',
  `status` enum('PENDING','ACTIVE','EXPIRED','CLOSED','CANCELLED') NOT NULL DEFAULT 'PENDING' COMMENT '状态：待上线/上线/已结束/已关闭/未成团取消',
  `share_token` varchar(20) DEFAULT NULL COMMENT '分享链接token，仅PUBLIC有值',
  `established_at` datetime DEFAULT NULL COMMENT '成团时间（达到最低人数后锁存，不回退）',
  `last_checked_at` datetime DEFAULT NULL COMMENT '最后检查时间（过期撤销用）',
  `created_by` bigint DEFAULT NULL COMMENT '创建管理员ID',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_share_token` (`share_token`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=22 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='车次';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_rides`
--

--
-- Table structure for table `pt_users`
--

DROP TABLE IF EXISTS `pt_users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pt_users` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `phone` varchar(20) DEFAULT NULL COMMENT '手机号（手机号登录用户，与邮箱二选一）',
  `email` varchar(255) DEFAULT NULL COMMENT '邮箱（邮箱验证码登录用户，与手机号二选一）',
  `password_hash` varchar(255) DEFAULT NULL COMMENT '密码哈希（可选，首期短信登录）',
  `nickname` varchar(50) DEFAULT NULL COMMENT '昵称',
  `avatar_url` varchar(500) DEFAULT NULL COMMENT '头像',
  `balance` bigint NOT NULL DEFAULT '0' COMMENT '钱包余额（额度值，1元=100000额度）',
  `cumulative_recharge` bigint NOT NULL DEFAULT '0' COMMENT '累计充值（额度值，成功到账累计）',
  `status` enum('ACTIVE','DISABLED') DEFAULT 'ACTIVE',
  `last_login_at` datetime DEFAULT NULL COMMENT '最近登录时间',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `phone` (`phone`),
  UNIQUE KEY `uk_email` (`email`),
  KEY `idx_phone` (`phone`)
) ENGINE=InnoDB AUTO_INCREMENT=21 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='拼车平台用户';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `pt_users`
--

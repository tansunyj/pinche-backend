-- ============================================================
-- 充值支付系统表结构
-- ============================================================

-- 充值订单表
CREATE TABLE IF NOT EXISTS `billing_orders` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `order_no` VARCHAR(64) NOT NULL UNIQUE COMMENT '业务订单号',
  `user_id` INT UNSIGNED NOT NULL COMMENT '用户ID',
  `amount` DECIMAL(10, 2) NOT NULL COMMENT '订单金额（元）',
  `points` INT UNSIGNED NOT NULL COMMENT '对应点数',
  `payment_channel` VARCHAR(32) NOT NULL COMMENT '支付渠道：alipay/wechat/stripe/paypal',
  `payment_method` VARCHAR(32) DEFAULT NULL COMMENT '支付方式详情',
  `status` ENUM('pending', 'paid', 'failed', 'refunded', 'expired') DEFAULT 'pending' COMMENT '订单状态',
  `third_party_order_no` VARCHAR(128) DEFAULT NULL COMMENT '第三方支付订单号',
  `paid_at` DATETIME DEFAULT NULL COMMENT '支付时间',
  `expired_at` DATETIME NOT NULL COMMENT '订单过期时间',
  `client_ip` VARCHAR(64) DEFAULT NULL COMMENT '客户端IP',
  `user_agent` TEXT DEFAULT NULL COMMENT '客户端UA',
  `created_at` DATETIME DEFAULT CURRENT_TIME,
  `updated_at` DATETIME DEFAULT CURRENT_TIME ON UPDATE CURRENT_TIME,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_order_no` (`order_no`),
  INDEX `idx_status` (`status`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='充值订单表';

-- 余额流水表
CREATE TABLE IF NOT EXISTS `billing_transactions` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT UNSIGNED NOT NULL COMMENT '用户ID',
  `type` ENUM('recharge', 'consume', 'refund', 'adjust') NOT NULL COMMENT '流水类型',
  `delta` INT NOT NULL COMMENT '变动数量（正为增加，负为减少）',
  `balance_after` INT NOT NULL COMMENT '变动后余额',
  `ref_type` VARCHAR(32) DEFAULT NULL COMMENT '关联类型：order/job 等',
  `ref_id` VARCHAR(64) DEFAULT NULL COMMENT '关联ID',
  `description` VARCHAR(255) DEFAULT NULL COMMENT '流水描述',
  `created_at` DATETIME DEFAULT CURRENT_TIME,
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_type` (`type`),
  INDEX `idx_ref` (`ref_type`, `ref_id`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='余额流水表';

-- 确保用户表有 balance 和 cumulative_recharge 字段
-- 如果字段不存在则添加
SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'user_users' AND COLUMN_NAME = 'balance'
  ),
  'ALTER TABLE `user_users` ADD COLUMN `balance` INT DEFAULT 0 COMMENT "当前余额（点）"',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'user_users' AND COLUMN_NAME = 'cumulative_recharge'
  ),
  'ALTER TABLE `user_users` ADD COLUMN `cumulative_recharge` INT DEFAULT 0 COMMENT "累计充值（点）"',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  NOT EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'user_users' AND COLUMN_NAME = 'overdraft_since'
  ),
  'ALTER TABLE `user_users` ADD COLUMN `overdraft_since` DATETIME DEFAULT NULL COMMENT "开始透支时间"',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
-- ============================================================
-- Token 拼车平台 - 拼车库 pt_carpool 建表 SQL
-- 依据：《拼车项目需求.md》附录 A（v0.8.2）
-- 网关表（proxy_tokens/proxy_logs/user_model_discounts 等）直连网关库，不在此建；
-- users 表已废弃（用户统一存 pt_users）
-- ============================================================

CREATE DATABASE IF NOT EXISTS pt_carpool DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pt_carpool;

-- A1. 用户表（用户唯一存储：注册即写这里，余额也在这里）
CREATE TABLE IF NOT EXISTS pt_users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  phone VARCHAR(20) NOT NULL UNIQUE COMMENT '手机号',
  password_hash VARCHAR(255) COMMENT '密码哈希（可选，首期短信登录）',
  nickname VARCHAR(50) COMMENT '昵称',
  avatar_url VARCHAR(500) COMMENT '头像',
  balance BIGINT NOT NULL DEFAULT 0 COMMENT '钱包余额（额度值，1元=100000额度）',
  cumulative_recharge BIGINT NOT NULL DEFAULT 0 COMMENT '累计充值（额度值，成功到账累计）',
  status ENUM('ACTIVE', 'DISABLED') DEFAULT 'ACTIVE',
  last_login_at DATETIME COMMENT '最近登录时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='拼车平台用户';

-- A2. 管理员表（初始管理员用 npm run seed 创建）
CREATE TABLE IF NOT EXISTS pt_admins (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('SUPER_ADMIN', 'OPERATOR') DEFAULT 'OPERATOR',
  status ENUM('ACTIVE', 'DISABLED') DEFAULT 'ACTIVE',
  last_login_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员';

-- A3. 充值档位表
CREATE TABLE IF NOT EXISTS pt_recharge_tiers (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  amount_yuan DECIMAL(10,2) NOT NULL COMMENT '金额（元）',
  quota BIGINT NOT NULL COMMENT '额度（网关计费单位，1元=100000）',
  display_order INT DEFAULT 0 COMMENT '显示顺序',
  enabled BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='充值档位';

-- A4. 车次表
CREATE TABLE IF NOT EXISTS pt_rides (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL COMMENT '车次名称，如"DeepSeek全家桶特惠"',
  description VARCHAR(500) COMMENT '车次描述',
  current_count INT DEFAULT 0 COMMENT '当前人数',
  min_count INT NOT NULL DEFAULT 1 COMMENT '最低成团人数（达到后车次自动成立）',
  start_time DATETIME COMMENT '车次开始时间（发车时间，到达后折扣自动生效、截止加入）',
  end_time DATETIME COMMENT '车次结束时间（= 上车截止 + 折扣过期，硬门禁）',
  status ENUM('PENDING', 'ACTIVE', 'EXPIRED', 'CLOSED', 'CANCELLED') DEFAULT 'PENDING' COMMENT '状态：待上线/上线/已结束/已关闭/未成团取消',
  share_token VARCHAR(20) COMMENT '分享链接token',
  established_at DATETIME COMMENT '成团时间（达到最低人数后锁存，不回退）',
  last_checked_at DATETIME COMMENT '最后检查时间（过期撤销用）',
  created_by BIGINT COMMENT '创建管理员ID',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_share_token (share_token),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='车次';

-- A4.2 车次模型分组表
CREATE TABLE IF NOT EXISTS pt_ride_groups (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ride_id BIGINT NOT NULL COMMENT '所属车次',
  discount_rate DECIMAL(3,2) NOT NULL COMMENT '该分组折扣率，如 0.60',
  display_order INT DEFAULT 0 COMMENT '显示顺序',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ride_id (ride_id),
  FOREIGN KEY (ride_id) REFERENCES pt_rides(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='车次模型分组';

-- A4.3 分组模型表
CREATE TABLE IF NOT EXISTS pt_ride_group_models (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  group_id BIGINT NOT NULL COMMENT '所属分组',
  ride_id BIGINT NOT NULL COMMENT '冗余车次ID，用于唯一约束',
  model_id VARCHAR(100) NOT NULL COMMENT '模型ID（带渠道前缀，如 aliyun/deepseek-v4-flash）',
  model_name VARCHAR(100) COMMENT '模型显示名',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ride_model (ride_id, model_id) COMMENT '同一车次内模型不可重复',
  INDEX idx_group_id (group_id),
  FOREIGN KEY (group_id) REFERENCES pt_ride_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (ride_id) REFERENCES pt_rides(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='分组内的模型';

-- A5. 上车记录表
CREATE TABLE IF NOT EXISTS pt_ride_members (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ride_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL COMMENT 'pt_users.id',
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  total_consumption BIGINT DEFAULT 0 COMMENT '该用户在该车次模型上的累计消费额度（用于活跃度回收豁免判断）',
  last_consumption_at DATETIME COMMENT '最后一次消费时间（用于活跃度回收扫描）',
  kicked_at DATETIME COMMENT '被请出时间（活跃度回收）',
  status ENUM('ACTIVE', 'KICKED') DEFAULT 'ACTIVE' COMMENT '成员状态',
  UNIQUE KEY uk_ride_user (ride_id, user_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status_joined (status, joined_at),
  FOREIGN KEY (ride_id) REFERENCES pt_rides(id),
  FOREIGN KEY (user_id) REFERENCES pt_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='上车记录';

-- A6. 支付流水表（status 扩展含 CALLBACK_RECEIVED/PROCESSING，适配充值到账状态机）
CREATE TABLE IF NOT EXISTS pt_payments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_no VARCHAR(64) NOT NULL UNIQUE COMMENT '业务订单号',
  user_id BIGINT NOT NULL COMMENT 'pt_users.id',
  tier_id BIGINT COMMENT '充值档位ID',
  amount_yuan DECIMAL(10,2) NOT NULL COMMENT '支付金额',
  quota BIGINT NOT NULL COMMENT '对应额度',
  provider ENUM('ALIPAY', 'WECHAT') DEFAULT 'ALIPAY',
  status ENUM('PENDING','CALLBACK_RECEIVED','PROCESSING','SUCCESS','FAILED','REFUNDED','CLOSED') DEFAULT 'PENDING',
  out_trade_no VARCHAR(64) UNIQUE COMMENT '支付宝交易号',
  refund_no VARCHAR(64) COMMENT '退款单号',
  paid_at DATETIME COMMENT '支付成功时间',
  refunded_at DATETIME COMMENT '退款时间',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_out_trade_no (out_trade_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付流水';

-- A8. 幂等表（防重复处理）
CREATE TABLE IF NOT EXISTS pt_idempotent_keys (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  biz_type VARCHAR(50) NOT NULL COMMENT '业务类型：RECHARGE/JOIN_RIDE/OPEN_ACCOUNT',
  biz_key VARCHAR(128) NOT NULL COMMENT '业务唯一键',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_biz (biz_type, biz_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='幂等键';

-- 充值到账任务队列（§2.6：异步可靠到账）
CREATE TABLE IF NOT EXISTS pt_payment_tasks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  payment_id BIGINT NOT NULL COMMENT 'pt_payments.id',
  order_no VARCHAR(64) NOT NULL,
  task_type ENUM('CREDIT_BALANCE') DEFAULT 'CREDIT_BALANCE',
  status ENUM('PENDING','PROCESSING','SUCCESS','FAILED') DEFAULT 'PENDING',
  retry_count INT DEFAULT 0,
  last_error VARCHAR(500),
  next_retry_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_next (status, next_retry_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='充值到账任务队列';

-- ============================================================
-- Seed：默认充值档位（1元 = 100000 额度）
-- ============================================================
INSERT INTO pt_recharge_tiers (amount_yuan, quota, display_order, enabled) VALUES
  (10.00,  1000000,  1, TRUE),   -- ¥10  = 100万额度
  (30.00,  3000000,  2, TRUE),   -- ¥30  = 300万额度
  (50.00,  5000000,  3, TRUE),   -- ¥50  = 500万额度
  (100.00, 10000000, 4, TRUE),   -- ¥100 = 1000万额度
  (200.00, 20000000, 5, TRUE),   -- ¥200 = 2000万额度
  (500.00, 50000000, 6, TRUE);   -- ¥500 = 5000万额度

-- Migration: 013_create_volc_assets
-- Purpose: 创建 volc_assets 表用于缓存火山引擎人像库素材
-- Date: 2026-07-23

CREATE TABLE IF NOT EXISTS volc_assets (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT COMMENT '自增主键',
  user_id INT UNSIGNED NOT NULL COMMENT '用户ID',
  asset_id VARCHAR(64) NOT NULL COMMENT 'VolcTokens 的素材ID',
  asset_uri VARCHAR(128) NOT NULL COMMENT '素材URI (asset://xxx)',
  asset_type VARCHAR(10) NOT NULL COMMENT '素材类型: Image / Video',
  name VARCHAR(255) DEFAULT NULL COMMENT '素材名称',
  status VARCHAR(16) NOT NULL DEFAULT 'processing' COMMENT '状态: processing/active/failed/deleted',
  preview_url TEXT COMMENT '素材预览URL（定时刷新）',
  delete_after BIGINT UNSIGNED DEFAULT NULL COMMENT '过期时间 (Unix秒)',
  duration_seconds DECIMAL(10,2) DEFAULT NULL COMMENT '视频素材时长',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',

  -- 联合唯一索引：同一用户的同一素材不重复
  UNIQUE KEY uk_user_asset (user_id, asset_id),

  -- 查询索引：按用户和状态查询
  INDEX idx_user_status (user_id, status),

  -- 查询索引：按状态查询（用于同步任务）
  INDEX idx_status (status)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='火山引擎人像库素材缓存表';

-- ============================================================
-- 007_create_media_module.sql
--   多媒体创作模块（Studio）DDL
--   新增 3 张表：media_assets / media_jobs / prompt_library
--
-- 依赖：user_users 已存在（user_id 外键）
-- 共享同一个 silievo 主库（与 server/ 老后台共存）
--
-- 执行：
--   mysql -h <host> -u <user> -p<password> silievo < 007_create_media_module.sql
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;


-- ─────────────── 媒体资产表 ───────────────
CREATE TABLE IF NOT EXISTS `media_assets` (
  `id`                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `user_id`           INT UNSIGNED      NOT NULL,
  `type`              VARCHAR(10)       NOT NULL                COMMENT 'image | video',
  `source`            VARCHAR(20)       NOT NULL                COMMENT 'generated | uploaded',

  -- 文件本体（OSS 地址）
  `oss_key`           VARCHAR(512)      NOT NULL                COMMENT 'OSS 对象 key',
  `mime`              VARCHAR(64)       NOT NULL                COMMENT 'image/png / video/mp4 等',
  `size_bytes`        BIGINT UNSIGNED   NOT NULL DEFAULT 0,

  -- 媒体元数据
  `width`             INT UNSIGNED      DEFAULT NULL,
  `height`            INT UNSIGNED      DEFAULT NULL,
  `duration_ms`       INT UNSIGNED      DEFAULT NULL            COMMENT '视频时长（毫秒），图片为 NULL',
  `thumbnail_oss_key` VARCHAR(512)      DEFAULT NULL            COMMENT '视频封面图 OSS key',

  -- 溯源
  `related_job_id`    BIGINT UNSIGNED   DEFAULT NULL            COMMENT '由哪个 job 生成（uploaded 时为 NULL）',

  -- 用户管理字段
  `name`              VARCHAR(255)      DEFAULT NULL            COMMENT '用户自定义名字',
  `tags`              JSON              DEFAULT NULL            COMMENT '用户打的标签数组',
  `is_favorite`       TINYINT UNSIGNED  NOT NULL DEFAULT 0      COMMENT '收藏=1',

  -- 生命周期
  `is_deleted`        TINYINT UNSIGNED  NOT NULL DEFAULT 0      COMMENT '0=正常 1=软删除',
  `deleted_at`        TIMESTAMP         NULL DEFAULT NULL,

  -- 审计
  `created_at`        TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_oss_key`        (`oss_key`),
  KEY         `idx_user_created` (`user_id`, `is_deleted`, `created_at` DESC),
  KEY         `idx_user_type`    (`user_id`, `type`, `is_deleted`, `created_at` DESC),
  KEY         `idx_user_favorite`(`user_id`, `is_favorite`, `is_deleted`, `created_at` DESC),
  KEY         `idx_related_job`  (`related_job_id`),
  KEY         `idx_cleanup`      (`is_deleted`, `deleted_at`),

  CONSTRAINT `fk_assets_user`
      FOREIGN KEY (`user_id`) REFERENCES `user_users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='媒体资产（图片/视频）';


-- ─────────────── 生成任务表 ───────────────
CREATE TABLE IF NOT EXISTS `media_jobs` (
  `id`                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `user_id`             INT UNSIGNED      NOT NULL,

  -- 任务种类与模型
  `kind`                VARCHAR(10)       NOT NULL                COMMENT 't2i | i2i | t2v | i2v | flf2v',
  `model_id`            VARCHAR(64)       NOT NULL                COMMENT '引用 marketplace.model_library.model_id（不加 FK）',
  `provider_name`       VARCHAR(32)       NOT NULL                COMMENT 'wanx | kling | mock 等，冗余便于 poller 路由',

  -- 输入
  `prompt`              TEXT              NOT NULL,
  `negative_prompt`     TEXT              DEFAULT NULL,
  `input_asset_id`      BIGINT UNSIGNED   DEFAULT NULL            COMMENT 'I2I/I2V 输入图 或 FLF2V 首帧',
  `input_asset_id_end`  BIGINT UNSIGNED   DEFAULT NULL            COMMENT '仅 FLF2V 尾帧',
  `params`              JSON              DEFAULT NULL            COMMENT '尺寸/时长/分辨率/seed/steps 等',

  -- 幂等
  `idempotency_key`     VARCHAR(64)       DEFAULT NULL            COMMENT '前端去重，UPSERT 用',

  -- 状态机
  `status`              VARCHAR(16)       NOT NULL DEFAULT 'pending'
                                          COMMENT 'pending | running | succeeded | failed | cancelled',
  `provider_task_id`    VARCHAR(128)      DEFAULT NULL            COMMENT '第三方任务号',
  `output_asset_id`     BIGINT UNSIGNED   DEFAULT NULL            COMMENT '代表性产物（多图时取第一张）',
  `error_msg`           TEXT              DEFAULT NULL,
  `retry_count`         TINYINT UNSIGNED  NOT NULL DEFAULT 0      COMMENT '第三方 submit 失败重试次数',

  -- 计费
  `points_estimated`    INT UNSIGNED      NOT NULL DEFAULT 0      COMMENT '预扣点数',
  `points_consumed`     INT UNSIGNED      NOT NULL DEFAULT 0      COMMENT '实际消费点数（成功后等于 estimated）',
  `points_refunded`     INT UNSIGNED      NOT NULL DEFAULT 0      COMMENT '失败/取消时退还点数',

  -- 时间
  `started_at`          TIMESTAMP         NULL DEFAULT NULL,
  `finished_at`         TIMESTAMP         NULL DEFAULT NULL,
  `created_at`          TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_idempotency`     (`user_id`, `idempotency_key`),
  KEY         `idx_user_created`   (`user_id`, `created_at` DESC),
  KEY         `idx_status_polling` (`status`, `updated_at`)         COMMENT 'poller 扫 running 任务',
  KEY         `idx_provider_task`  (`provider_name`, `provider_task_id`) COMMENT '未来 webhook 反查',
  KEY         `idx_user_kind`      (`user_id`, `kind`, `created_at` DESC),

  CONSTRAINT `fk_jobs_user`
      FOREIGN KEY (`user_id`)            REFERENCES `user_users`(`id`)   ON DELETE CASCADE,
  CONSTRAINT `fk_jobs_input_asset`
      FOREIGN KEY (`input_asset_id`)     REFERENCES `media_assets`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_jobs_input_asset_end`
      FOREIGN KEY (`input_asset_id_end`) REFERENCES `media_assets`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_jobs_output_asset`
      FOREIGN KEY (`output_asset_id`)    REFERENCES `media_assets`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='媒体生成任务';


-- ─────────────── 提示词收藏夹 ───────────────
CREATE TABLE IF NOT EXISTS `prompt_library` (
  `id`              BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `user_id`         INT UNSIGNED      NOT NULL,

  `content`         TEXT              NOT NULL                COMMENT '提示词正文',
  `content_hash`    CHAR(64)          NOT NULL                COMMENT 'SHA-256(content)，用于同一用户去重',
  `name`            VARCHAR(255)      DEFAULT NULL            COMMENT '用户起的别名（可空）',
  `tags`            JSON              DEFAULT NULL,

  `source_job_id`   BIGINT UNSIGNED   DEFAULT NULL            COMMENT '从哪条 job 收藏来的',
  `use_count`       INT UNSIGNED      NOT NULL DEFAULT 0      COMMENT '被一键复用次数',
  `last_used_at`    TIMESTAMP         NULL DEFAULT NULL,

  `created_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_hash`        (`user_id`, `content_hash`),
  KEY         `idx_user_created`    (`user_id`, `created_at` DESC),
  KEY         `idx_user_use_count`  (`user_id`, `use_count` DESC, `last_used_at` DESC),

  CONSTRAINT `fk_prompts_user`
      FOREIGN KEY (`user_id`)       REFERENCES `user_users`(`id`)   ON DELETE CASCADE,
  CONSTRAINT `fk_prompts_source_job`
      FOREIGN KEY (`source_job_id`) REFERENCES `media_jobs`(`id`)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户提示词收藏夹';


SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- 回滚（仅供开发参考，生产慎用）：
--   DROP TABLE IF EXISTS prompt_library;
--   DROP TABLE IF EXISTS media_jobs;
--   DROP TABLE IF EXISTS media_assets;
-- ============================================================

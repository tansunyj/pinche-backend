-- media_jobs 字段重命名：points_estimated/consumed/refunded → estimated/consumed/refunded
-- 存储单位保持为"点"（额度），前端显示时换算成元

ALTER TABLE `media_jobs`
  CHANGE COLUMN `points_estimated` `estimated` BIGINT UNSIGNED NOT NULL DEFAULT '0'
    COMMENT '预估消耗额度（点）',
  CHANGE COLUMN `points_consumed` `consumed` BIGINT UNSIGNED NOT NULL DEFAULT '0'
    COMMENT '实际消耗额度（点）',
  CHANGE COLUMN `points_refunded` `refunded` BIGINT UNSIGNED NOT NULL DEFAULT '0'
    COMMENT '退回额度（点）';

-- MySQL 慢查询日志配置
-- 用于排查性能问题，找出执行时间超过阈值的 SQL

-- ========== 查看当前慢查询日志状态 ==========
SHOW VARIABLES LIKE 'slow_query_log';
SHOW VARIABLES LIKE 'slow_query_log_file';
SHOW VARIABLES LIKE 'long_query_time';
SHOW VARIABLES LIKE 'log_queries_not_using_indexes';

-- ========== 开启慢查询日志（临时生效，重启后失效） ==========
-- 开启慢查询日志
SET GLOBAL slow_query_log = 'ON';

-- 设置慢查询时间阈值（单位：秒），超过这个时间的 SQL 会被记录
-- 建议开发环境设为 1 秒，生产环境设为 2 秒
SET GLOBAL long_query_time = 2;

-- （可选）记录未使用索引的查询
SET GLOBAL log_queries_not_using_indexes = 'ON';

-- ========== 配置慢查询日志文件路径（可选） ==========
-- 注意：需要确保 MySQL 用户有写入权限
-- SET GLOBAL slow_query_log_file = '/var/lib/mysql/slow.log';

-- ========== 验证配置是否生效 ==========
SHOW VARIABLES LIKE 'slow_query_log';
SHOW VARIABLES LIKE 'long_query_time';

-- ========== 查看慢查询日志内容（Linux） ==========
-- tail -f /var/lib/mysql/slow.log

-- ========== 关闭慢查询日志 ==========
-- SET GLOBAL slow_query_log = 'OFF';

-- ========== 永久生效配置（需修改 my.cnf） ==========
-- 编辑 /etc/mysql/my.cnf 或 /etc/my.cnf，添加：
-- [mysqld]
-- slow_query_log = 1
-- slow_query_log_file = /var/lib/mysql/slow.log
-- long_query_time = 2
-- log_queries_not_using_indexes = 1

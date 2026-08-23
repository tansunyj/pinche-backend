-- 在 Ubuntu 服务器上执行此脚本
-- 开启慢查询日志并设置正确的路径

-- 查看当前配置
SHOW VARIABLES LIKE 'slow_query%';
SHOW VARIABLES LIKE 'datadir';

-- 开启慢查询日志
SET GLOBAL slow_query_log = 'ON';

-- 设置慢查询时间阈值为 2 秒
SET GLOBAL long_query_time = 2;

-- 记录未使用索引的查询
SET GLOBAL log_queries_not_using_indexes = 'ON';

-- 尝试设置日志文件路径（如果上面的路径不对）
-- 通常 Ubuntu 上 MySQL 数据目录是 /var/lib/mysql/
-- SET GLOBAL slow_query_log_file = '/var/lib/mysql/slow.log';

-- 验证配置
SHOW VARIABLES LIKE 'slow_query%';

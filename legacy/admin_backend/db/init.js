// env 在入口 (index.js) 已统一加载，这里直接使用 process.env
const mysql = require('mysql2/promise');

let pool;

// 日志输出函数
function log(level, message, data) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [DB:${level}]`;
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

/**
 * 获取数据库连接池
 */
async function getDb() {
  if (!pool) {
    const config = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'silievo',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      timezone: '+08:00', // 设置 Node.js 处理日期的时区基准
    };

    log('INFO', '正在创建数据库连接池...');
    log('INFO', `连接配置: host=${config.host}, user=${config.user}, database=${config.database}`);

    try {
      pool = mysql.createPool(config);
      log('INFO', '连接池创建成功，验证连接...');

      // 验证连接并同步数据库时区
      await pool.query("SET time_zone = '+08:00'");
      log('INFO', '数据库时区设置成功 (+08:00)');

      await initializeDatabase(pool);
      log('INFO', '数据库初始化完成');
    } catch (err) {
      log('ERROR', '无法连接到 MySQL 数据库:', err.message);
      log('ERROR', '错误详情:', { code: err.code, errno: err.errno, sqlState: err.sqlState });
      throw err;
    }
  }
  return pool;
}

/**
 * 初始化数据库表结构与种子数据
 */
async function initializeDatabase(connPool) {
  log('INFO', '开始初始化数据库...');
  try {
    const connection = await connPool.getConnection();
    log('INFO', '获取数据库连接成功');

    // 检查并创建用户表（如果需要，或者只是检查种子数据）
    // 这里我们主要确保至少有一个管理员账号
    log('INFO', '检查 proxy_users 表...');
    const [rows] = await connection.execute('SELECT COUNT(*) as count FROM proxy_users');
    log('INFO', `proxy_users 表记录数: ${rows[0].count}`);

    if (rows[0].count === 0) {
      console.log('[Database] 正在初始化默认管理员账号...');
      const bcrypt = require('bcryptjs');
      const hashed = bcrypt.hashSync('admin123', 12);
      await connection.execute(
        'INSERT INTO proxy_users (username, password, role) VALUES (?, ?, ?)',
        ['admin', hashed, 'admin']
      );
      console.log('[Database] 默认管理员: admin / admin123 已创建');
    }

    connection.release();
    log('INFO', '数据库连接已释放');
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      log('ERROR', '数据库表尚未创建，请先执行 schema.sql 初始化数据库结构。');
      log('ERROR', `缺失的表: ${err.message}`);
    } else {
      log('ERROR', '初始化检查失败:', err.message);
      log('ERROR', '错误堆栈:', err.stack);
    }
  }
}

/**
 * 封装 query 方法，自动释放连接
 */
async function query(sql, params) {
  log('DEBUG', `执行 SQL: ${sql.substring(0, 100)}...`, params ? { params } : undefined);
  const db = await getDb();
  const [results] = await db.execute(sql, params || []);
  const safeResults = Array.isArray(results) ? results : [];
  log('DEBUG', `SQL 执行完成，返回 ${safeResults.length} 条记录`);
  return safeResults;
}

/**
 * 封装事务处理
 */
async function transaction(callback) {
  const db = await getDb();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  getDb,
  query,
  transaction
};

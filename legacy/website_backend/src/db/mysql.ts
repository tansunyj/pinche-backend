import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "123456",
  database: process.env.MYSQL_DATABASE || "silievo",
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_SIZE) || 10,
  queueLimit: 0,
  charset: "utf8mb4",
  timezone: "+08:00",
  decimalNumbers: true,
  dateStrings: false,
  // 防止注入：禁用多语句执行
  multipleStatements: false,
});

/**
 * 健康检查 - 启动时调用以验证连接
 */
export async function checkMysqlConnection(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

/**
 * 在事务中执行回调；自动 BEGIN / COMMIT / ROLLBACK。
 * 用法：
 *   await transaction(async (conn) => {
 *     await conn.execute('INSERT INTO ...', [...]);
 *     await conn.execute('UPDATE ...', [...]);
 *   });
 */
export async function transaction<T>(
  fn: (conn: mysql.PoolConnection) => Promise<T>
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr);
    }
    throw err;
  } finally {
    conn.release();
  }
}

export default pool;

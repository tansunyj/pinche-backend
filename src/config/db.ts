/**
 * 双 MySQL 连接池：
 *   - gatewayPool：并入 pt_carpool 的网关表（proxy_tokens / proxy_logs / proxy_channels / model_library ...）。
 *     注：users 表已废弃（用户统一存 pt_users）；user_model_discounts 未并入（仍在 silievo_dev），carpool 已不再读写它。
 *   - carpoolPool：拼车库 pt_carpool，存 pt_ 前缀业务表
 *
 * 共用 host/port/user/password，仅 database 不同。连接参数遵循网关约定
 * （utf8mb4、+08:00 时区、decimalNumbers），保证与网关读写口径一致。
 */

import mysql from "mysql2/promise";

function baseConfig() {
  return {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "123456",
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE) || 10,
    queueLimit: 0,
    charset: "utf8mb4",
    timezone: "+08:00",
    decimalNumbers: true,
    dateStrings: false,
    // 防止注入：禁用多语句执行
    multipleStatements: false,
  };
}

/** 网关库连接池（直连只读/受控写入网关表） */
export const gatewayPool = mysql.createPool({
  ...baseConfig(),
  database: process.env.GATEWAY_DB || "silievo",
});

/** 拼车库连接池（pt_ 前缀业务表） */
export const carpoolPool = mysql.createPool({
  ...baseConfig(),
  database: process.env.CARPOOL_DB || "pt_carpool",
});

/** 启动时验证两个库连接 */
export async function checkConnections(): Promise<void> {
  const [gw, cp] = await Promise.all([
    gatewayPool.getConnection(),
    carpoolPool.getConnection(),
  ]);
  try {
    await Promise.all([gw.ping(), cp.ping()]);
  } finally {
    gw.release();
    cp.release();
  }
}

/** 网关库查询 helper */
export async function gwQuery(sql: string, params?: any[]) {
  const [rows] = await gatewayPool.execute(sql, params || []);
  return rows as any;
}

/** 拼车库查询 helper */
export async function cpQuery(sql: string, params?: any[]) {
  const [rows] = await carpoolPool.execute(sql, params || []);
  return rows as any;
}

/** 网关库事务 */
export async function gwTransaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await gatewayPool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (e) { console.error("gw rollback failed:", e); }
    throw err;
  } finally {
    conn.release();
  }
}

/** 拼车库事务 */
export async function cpTransaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await carpoolPool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (e) { console.error("cp rollback failed:", e); }
    throw err;
  } finally {
    conn.release();
  }
}

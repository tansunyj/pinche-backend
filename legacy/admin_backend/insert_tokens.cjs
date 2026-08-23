#!/usr/bin/env node
/**
 * 批量插入活动 token 到 proxy_tokens 表
 * 流程: 遍历所有用户 -> 检查是否已发过活动 token -> 没发的就发一个
 * 用法: node insert_tokens.cjs
 */

const mysql = require('mysql2/promise');
const crypto = require('crypto');

// ============== 配置区 ==============

// 数据库配置
const DB_CONFIG = {
  host: 'localhost',
  port: 3306,
  user: 'silievo',
  password: '>Flg412zc5z%Z_0f=^WN;!*|VD.YG1yu',
  database: 'silievo_prod',
};

// 活动 token 配置（统一配置，所有用户相同）
const TOKEN_CONFIG = {
  name: '阿里云百炼模型免费体验周',
  token_group_code: 'default',
  models: 'qwen-image-2.0,qwen-image-2.0-pro,wan2.7-image-pro,wan2.7-image,qwen-max,qwen3.6-flash-2026-04-16,qwen3.6-flash,qwen3.6-max-preview,qwen3.6-plus-2026-04-02,qwen3.6-plus,deepseek-v4-pro,deepseek-v4-flash,kimi-k2.6,happyhorse-1.0-i2v,happyhorse-1.0-t2v,happyhorse-1.0-r2v,glm-5.1,glm-5',
  quota: 0,
  used_quota: 0,
  remain_quota: 0,
  start_at: '2026-05-25 00:00:00',
  expired_at: '2026-05-31 23:59:59',
  status: 1,
  channel_id: null,
  price_markup: 1.0000,
  api_key: '',
  created_at: '2026-05-24 05:35:26',
  rate_limit_rpm: 10,
};

// ============== 工具函数 ==============

/**
 * 生成唯一的 token key
 * 格式: sk-aliyun-<随机字符串>
 */
function generateTokenKey() {
  const prefix = 'sk-aliyun-';
  const randomBytes = crypto.randomBytes(32);
  const randomStr = randomBytes.toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 32);
  return prefix + randomStr;
}

/**
 * 检查用户是否已存在相同特征的活动 token
 * 匹配条件: user_id + name + quota=0 + remain_quota=0 + start_at + expired_at
 * @param {mysql.Connection} connection
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function hasExistingToken(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT id FROM proxy_tokens
     WHERE user_id = ?
       AND name = ?
       AND quota = 0
       AND remain_quota = 0
       AND start_at = ?
       AND expired_at = ?
     LIMIT 1`,
    [userId, TOKEN_CONFIG.name, TOKEN_CONFIG.start_at, TOKEN_CONFIG.expired_at]
  );
  return rows.length > 0;
}

/**
 * 获取所有用户
 * @param {mysql.Connection} connection
 * @returns {Promise<Array<{id: number, phone: string, name: string}>>}
 */
async function getAllUsers(connection) {
  const [rows] = await connection.execute(
    'SELECT id, phone, name FROM user_users WHERE deleted_at IS NULL ORDER BY id'
  );
  return rows.map(r => ({ id: r.id, phone: r.phone, name: r.name }));
}

/**
 * 生成批量 INSERT SQL 语句
 */
function buildInsertSQL(tokens) {
  const columns = [
    'user_id', 'name', '\`key\`', 'token_group_code', 'models',
    'quota', 'used_quota', 'remain_quota', 'start_at', 'expired_at',
    'status', 'channel_id', 'price_markup', 'api_key', 'created_at', 'rate_limit_rpm'
  ];

  const placeholders = tokens.map(() => {
    return `(${columns.map(() => '?').join(', ')})`;
  }).join(',\n');

  const sql = `INSERT INTO proxy_tokens
  (${columns.join(', ')})
VALUES
  ${placeholders};`;

  const values = tokens.flatMap(t => [
    t.user_id,
    t.name,
    t.key,
    t.token_group_code,
    t.models,
    t.quota,
    t.used_quota,
    t.remain_quota,
    t.start_at,
    t.expired_at,
    t.status,
    t.channel_id,
    t.price_markup,
    t.api_key,
    t.created_at,
    t.rate_limit_rpm,
  ]);

  return { sql, values };
}

// ============== 主逻辑 ==============

async function main() {
  let connection;

  try {
    // 创建数据库连接
    connection = await mysql.createConnection(DB_CONFIG);
    console.log('数据库连接成功\n');

    // 第一步: 获取所有用户
    console.log('=== 第一步: 获取所有用户 ===');
    const users = await getAllUsers(connection);
    console.log(`  共找到 ${users.length} 个用户\n`);

    if (users.length === 0) {
      console.log('没有用户，操作结束');
      return;
    }

    // 第二步: 检查每个用户是否已发放，未发放则生成 token
    console.log('=== 第二步: 检查并生成 Token ===');
    const tokens = [];
    const skippedUsers = [];

    for (const user of users) {
      const exists = await hasExistingToken(connection, user.id);
      if (exists) {
        skippedUsers.push(user);
        console.log(`  ⊘ 用户 ${user.id} (${user.phone || '无手机号'}) 已存在活动 token，跳过`);
        continue;
      }

      const key = generateTokenKey();
      tokens.push({
        user_id: user.id,
        name: TOKEN_CONFIG.name,
        key,
        token_group_code: TOKEN_CONFIG.token_group_code,
        models: TOKEN_CONFIG.models,
        quota: TOKEN_CONFIG.quota,
        used_quota: TOKEN_CONFIG.used_quota,
        remain_quota: TOKEN_CONFIG.remain_quota,
        start_at: TOKEN_CONFIG.start_at,
        expired_at: TOKEN_CONFIG.expired_at,
        status: TOKEN_CONFIG.status,
        channel_id: TOKEN_CONFIG.channel_id,
        price_markup: TOKEN_CONFIG.price_markup,
        api_key: TOKEN_CONFIG.api_key,
        created_at: TOKEN_CONFIG.created_at,
        rate_limit_rpm: TOKEN_CONFIG.rate_limit_rpm,
      });
      console.log(`  ✓ 用户 ${user.id} (${user.phone || '无手机号'}) -> 生成 Token`);
    }

    console.log(`\nToken 生成结果: 新增 ${tokens.length} 个, 跳过 ${skippedUsers.length} 个`);

    if (tokens.length === 0) {
      console.log('没有需要插入的新 token，操作结束');
      return;
    }

    // 第三步: 执行插入
    console.log(`\n=== 第三步: 插入 proxy_tokens 表 ===`);
    const { sql, values } = buildInsertSQL(tokens);

    console.log('SQL 预览:');
    console.log(sql.substring(0, 300) + '...');
    console.log(`\n准备插入 ${tokens.length} 条记录...`);

    const [result] = await connection.execute(sql, values);
    console.log(`\n✓ 插入成功！影响行数: ${result.affectedRows}`);

    // 打印完整的 token 信息（用于记录/分发）
    console.log('\n=== 插入的 Token 详情 ===');
    tokens.forEach((t, i) => {
      console.log(`\n${i + 1}. 用户ID: ${t.user_id}`);
      console.log(`   名称: ${t.name}`);
      console.log(`   Key: ${t.key}`);
    });

  } catch (error) {
    console.error('\n执行出错:', error.message);
    if (error.code === 'ER_DUP_ENTRY') {
      console.error('错误原因: token key 重复，请重新运行脚本');
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('\n数据库连接已关闭');
    }
  }
}

// 运行
main();

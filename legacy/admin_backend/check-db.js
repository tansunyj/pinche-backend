/**
 * 数据库诊断脚本
 * 检查必要的表是否存在
 */

require('./utils/env');
const { query, getDb } = require('./db/init');

async function checkDatabase() {
  console.log('========================================');
  console.log('📊 数据库连接诊断');
  console.log('========================================');

  // 1. 检查环境变量
  console.log('\n📋 环境变量:');
  console.log('  NODE_ENV:', process.env.NODE_ENV);
  console.log('  DB_HOST:', process.env.DB_HOST);
  console.log('  DB_USER:', process.env.DB_USER);
  console.log('  DB_NAME:', process.env.DB_NAME);

  try {
    // 2. 测试连接
    console.log('\n📡 测试数据库连接...');
    await getDb();
    console.log('  ✅ 连接成功');

    // 3. 检查关键表是否存在
    console.log('\n📑 检查关键表:');
    const tables = [
      'proxy_users',
      'proxy_channels',
      'proxy_tokens',
      'proxy_logs',
      'proxy_model_prices',
      'proxy_channel_models',
      'proxy_channel_tokens'
    ];

    for (const table of tables) {
      try {
        const rows = await query(`SHOW TABLES LIKE ?`, [table]);
        if (rows.length > 0) {
          console.log(`  ✅ ${table}`);

          // 检查表中有多少数据
          const count = await query(`SELECT COUNT(*) as cnt FROM \`${table}\``);
          console.log(`     记录数: ${count[0].cnt}`);
        } else {
          console.log(`  ❌ ${table} - 表不存在!`);
        }
      } catch (e) {
        console.log(`  ❌ ${table} - 错误: ${e.message}`);
      }
    }

    // 4. 检查 proxy_users 表结构
    console.log('\n🔍 proxy_users 表结构:');
    try {
      const cols = await query(`DESCRIBE proxy_users`);
      cols.forEach(col => {
        console.log(`  - ${col.Field}: ${col.Type}`);
      });
    } catch (e) {
      console.log('  ❌ 无法获取表结构:', e.message);
    }

    console.log('\n========================================');
    console.log('✅ 诊断完成');
    console.log('========================================');

    process.exit(0);
  } catch (e) {
    console.error('\n❌ 数据库连接失败:', e.message);
    console.error('请检查 .env.production 中的数据库配置');
    process.exit(1);
  }
}

checkDatabase();

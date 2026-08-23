/**
 * 检查今日活跃渠道和令牌数
 */
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '123456',
    database: 'silievo'
  });

  // 今日活跃渠道数
  const [channels] = await conn.execute(`
    SELECT COUNT(DISTINCT dim1_key) as count
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'channel'
      AND metric_name = 'requests'
      AND metric_value > 0
  `);
  console.log('今日活跃渠道数:', channels[0].count);

  // 今日活跃Token数
  const [tokens] = await conn.execute(`
    SELECT COUNT(DISTINCT dim1_key) as count
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'token'
      AND metric_name = 'requests'
      AND metric_value > 0
  `);
  console.log('今日活跃Token数:', tokens[0].count);

  // 渠道和Token总数
  const [channelTotal] = await conn.execute('SELECT COUNT(*) as count FROM proxy_channels WHERE status = 1');
  const [tokenTotal] = await conn.execute('SELECT COUNT(*) as count FROM proxy_tokens WHERE status = 1');
  console.log('总渠道数:', channelTotal[0].count);
  console.log('总令牌数:', tokenTotal[0].count);

  // 显示渠道详情
  const [channelDetails] = await conn.execute(`
    SELECT dim1_key, metric_value
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'channel'
      AND metric_name = 'requests'
      AND metric_value > 0
  `);
  console.log('\n活跃渠道详情:');
  channelDetails.forEach(r => console.log(' ', r.dim1_key, ':', r.metric_value));

  // 显示token详情
  const [tokenDetails] = await conn.execute(`
    SELECT dim1_key, metric_value
    FROM unified_stats
    WHERE stat_date = CURDATE()
      AND dim_type = 'token'
      AND metric_name = 'requests'
      AND metric_value > 0
  `);
  console.log('\n活跃令牌详情:');
  tokenDetails.forEach(r => console.log(' ', r.dim1_key, ':', r.metric_value));

  await conn.end();
}

main().catch(console.error);

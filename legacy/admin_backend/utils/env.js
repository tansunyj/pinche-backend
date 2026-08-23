/**
 * 环境变量加载器（CommonJS）
 *
 * 加载优先级（已存在的不会被后续文件覆盖）：
 *   .env.{NODE_ENV}.local
 *   .env.{NODE_ENV}
 *   .env.local            （production 下不加载，与 Next.js 行为一致）
 *   .env
 *
 * 通过 `cross-env NODE_ENV=development|production` 在 npm scripts 中切换。
 * 必须在 require 任何业务模块之前 require 本文件。
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const NODE_ENV = process.env.NODE_ENV || 'development';
const projectRoot = path.resolve(__dirname, '..');

const candidates = [
  `.env.${NODE_ENV}.local`,
  `.env.${NODE_ENV}`,
  ...(NODE_ENV === 'production' ? [] : ['.env.local']),
  '.env',
];

const loaded = [];
for (const name of candidates) {
  const filePath = path.join(projectRoot, name);
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath });
    loaded.push(name);
  }
}

console.log(`[env] NODE_ENV=${NODE_ENV} loaded=${loaded.join(', ') || '(none)'}`);

module.exports = { NODE_ENV };

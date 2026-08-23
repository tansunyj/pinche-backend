/**
 * 构建后处理脚本
 * 复制配置文件和脚本到 dist 目录
 */
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');

// 确保 dist 目录存在
if (!fs.existsSync(distDir)) {
  console.error('dist 目录不存在，请先运行 tsc');
  process.exit(1);
}

// 需要复制的文件
const filesToCopy = [
  '.env.production',
  'restart.sh'
];

console.log('复制配置文件到 dist 目录...\n');

for (const file of filesToCopy) {
  const src = path.join(__dirname, file);
  const dest = path.join(distDir, file);

  try {
    if (fs.existsSync(src)) {
      // 先删除旧文件（如果存在）
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      fs.copyFileSync(src, dest);
      const stats = fs.statSync(src);
      console.log(`✓ ${file} (${stats.size} bytes)`);
    } else {
      console.warn(`⚠ ${file} 不存在，跳过`);
    }
  } catch (err) {
    console.error(`✗ 复制 ${file} 失败:`, err.message);
  }
}

console.log('\n构建后处理完成！');
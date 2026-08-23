/**
 * admin_backend 部署准备脚本
 * 复制所有文件到部署目录
 */
const fs = require('fs');
const path = require('path');

// 确定目标目录 - 默认为当前目录的 dist 子目录
const targetDir = path.join(__dirname, 'dist');

// 需要复制的文件和目录
const itemsToCopy = [
  'index.js',
  'package.json',
  'package-lock.json',
  '.env.production',
  'restart.sh',
  'routes',
  'middleware',
  'services',
  'repositories',
  'db',
  'utils',
  'schema',
  'scripts',
  'data'
];

// 需要排除的目录/文件
const excludeList = ['node_modules', '.git', 'dist'];

console.log('准备部署文件...\n');
console.log(`目标目录: ${targetDir}\n`);

// 确保目标目录存在
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;

  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (!excludeList.includes(entry.name)) {
        copyDir(srcPath, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

let copiedCount = 0;

for (const item of itemsToCopy) {
  const src = path.join(__dirname, item);
  const dest = path.join(targetDir, item);

  try {
    if (fs.existsSync(src)) {
      const stat = fs.statSync(src);

      if (stat.isDirectory()) {
        copyDir(src, dest);
        console.log(`✓ ${item}/ (目录)`);
      } else {
        fs.copyFileSync(src, dest);
        console.log(`✓ ${item} (${stat.size} bytes)`);
      }
      copiedCount++;
    } else {
      console.warn(`⚠ ${item} 不存在，跳过`);
    }
  } catch (err) {
    console.error(`✗ 复制 ${item} 失败:`, err.message);
  }
}

console.log(`\n部署准备完成！共复制 ${copiedCount} 个项目`);
console.log('\n部署步骤:');
console.log('1. 上传整个 dist 目录到服务器');
console.log('2. 在服务器上执行: npm install --production');
console.log('3. 执行: sh restart.sh');
/**
 * PM2 Ecosystem Configuration
 * Usage: pm2 start ecosystem.config.js
 */
module.exports = {
  apps: [
    {
      name: "silievo-site-backend",
      script: "npx",
      args: "tsx src/index.ts",
      cwd: "/var/www/html/website/backend",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      // 从 .env.production 加载环境变量
      // PM2 会自动加载 cwd 目录下的 .env 文件
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 5,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      // 环境变量只能从当前 shell 或 .env 文件继承
      // 确保 .env.production 存在于 cwd 目录
    },
  ],
};

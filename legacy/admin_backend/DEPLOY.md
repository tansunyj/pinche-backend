# Admin Backend 部署（Docker 容器，服务器本地构建）

## 架构

- **构建**：在本仓库目录内 `docker compose up -d --build`，镜像本地打 `silievo-admin-backend:local`，**不推任何镜像仓库**
- **网络**：`network_mode: host` —— 容器与宿主机共享网络，应用照旧监听 `127.0.0.1:3001`，nginx 反代配置一行不用改
- **环境变量**：`env_file` 读取仓库根目录 `./.env.production`（与 pm2 时代同一份）。`.env*` 不进 git，服务器 clone 后单独放置
- **资源**：`mem_limit 512m`，cron 凌晨并发时只崩自己，绝不崩宿主机

## 服务器一次性准备

```bash
# 1. 安装 Docker + git（若未装）
curl -fsSL https://get.docker.com | sh && systemctl enable --now docker

# 2. clone 私有仓库（需 git 凭据：HTTPS PAT 或 SSH key，仓库须为 Private）
cd /opt/silievo
git clone https://github.com/tansunyj/silievo-admin-backend.git admin_backend
cd admin_backend

# 3. 放生产配置（.env* 不进 git，用 scp 单独传；清 Windows 换行/BOM）
scp user@local:admin_backend/.env.production ./
sed -i 's/\r$//; s/^\xef\xbb\xbf//' .env.production
```

> **注意**：`.env.production` 含数据库/支付等生产密钥，**绝不提交到 git**，只在服务器上单独存放。

## 部署 / 升级 / 回滚

```bash
cd /opt/silievo/admin_backend

# ---- 首次部署 / 日常发版（git pull 到最新后重建）----
git pull
docker compose up -d --build

# ---- 验证 ----
curl -s http://127.0.0.1:3001/api/health
docker compose ps            # STATUS 应为 healthy

# ---- 回滚（切到上一个已发布 commit 重建）----
git log --oneline -5         # 找要回退的 commit
git checkout <旧commit/tag>
docker compose up -d --build
# 确认正常后可以 git checkout <部署分支> && 按你的版本管理习惯处理
```

> 日常维护用 `docker compose stop`（保留容器），不要 `down`（会删容器）。完整切回 PM2 先 `docker compose down`。

## 依赖关系

- 依赖宿主机 MySQL(3306)/Redis(6379)，连接地址在 `.env.production` 里
- 管理后台前端 `admin_frontend` 由宿主机 nginx 托管，`proxy_pass http://127.0.0.1:3001` 保持不变
- 生产库部署时若涉及 DDL 变更（如新增表/列），同步执行 `docs/同步DDL-生产.sql`（如有）

# Token 拼车平台 · 后端服务（carpool/server）

> 「Token 拼车（共享额度）平台」的统一后端：一个 Express + TypeScript 进程同时服务 **用户端**、**管理端** 与 **系统接口**，负责账号认证、车次拼车、API 令牌、消费日志、充值到账与模型定价等全部业务。

配套前端：`carpool/web`（React + Rsbuild，端口 3000）。本文档默认中文，英文版见 [English](#english)。

---

## 目录

- [相关仓库](#相关仓库)
- [加入交流群](#加入交流群)
- [项目简介](#项目简介)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [核心功能](#核心功能)
- [API 概览](#api-概览)
- [定时任务](#定时任务)
- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [脚本](#脚本)
- [环境变量](#环境变量)
- [目录结构](#目录结构)
- [开发联调](#开发联调)
- [English](#english)

---

## 相关仓库

本平台共分 **3 个子项目**，各对应一个独立 Git 仓库：

| 子项目（GitHub 仓库名） | 说明 | Git 地址 |
| ------ | ---- | -------- |
| `pinche-frontend` | 前端 | `https://github.com/tansunyj/pinche-frontend.git` |
| `pinche-backend` | 后端服务 | `https://github.com/tansunyj/pinche-backend.git` |
| `pinche-gateway` | 网关代理 | `https://github.com/tansunyj/pinche-gateway.git` |

> 本仓库是其中的 **`pinche-backend`（后端服务）** 子项目（本地目录 `server`）。三个仓库相互独立，需分别 `git clone` / `git push`；跨仓库协作时各自独立提交、互不影响。

---

## 加入交流群

群号：**663707675**

![Token 拼车群](token拼车群.png)

> 扫码或搜索群号加入 **Token 拼车平台交流群**，获取平台动态、使用答疑与优惠信息。
> Scan the QR code / search group **663707675** to join the Token Carpool community.

---

## 项目简介

**业务模式**：平台按 token 额度计费，单个用户额度有限。多个用户组成「车次」（Ride），达到最低人数成团后共享打折后的模型调用价格，从而降低使用成本。管理员创建车次、配置折扣分组与可调用模型；用户加入车次享受对应折扣。

后端单进程覆盖三端：

- **用户端**：手机号 / 邮箱验证码登录（未注册自动开户）、个人资料、余额（额度）、API Key 管理、消费日志、我的车次、我的折扣、充值。
- **管理端**（`/api/admin/*`）：管理员登录、用户管理、车次管理（成员 / 折扣分组 / 发车状态）、渠道与模型管理、令牌管理、支付记录、统计、消费日志详情、充值档位。
- **系统接口**：平台状态、公告、自定义首页内容、模型定价、健康检查等，供前端公共页面消费。

---

## 技术栈

| 类别 | 技术 |
| ---- | ---- |
| 语言 / 运行时 | TypeScript、Node.js ≥ 20 |
| Web 框架 | Express 4 |
| 数据库 | MySQL（mysql2 连接池，utf8mb4、+08:00、decimalNumbers） |
| 缓存 / 会话 | Redis（ioredis） |
| 认证 | JWT（jsonwebtoken）：用户端 + 管理端双体系 |
| 参数校验 | express-validator、zod |
| 密码 | bcryptjs |
| 支付 | alipay-sdk（扫码支付） |
| 短信 / 邮件 | 阿里云短信（原生 fetch + HMAC-SHA1 签名）、nodemailer |
| 人机验证 | Cloudflare Turnstile |
| 定时任务 | node-cron |
| 安全 | helmet、cors、express-rate-limit |
| 构建 / 运行 | tsc、tsx、cross-env |

---

## 系统架构

```
浏览器 / 前端（carpool/web，:3000）
          │  CORS → /api/*
          ▼
   carpool/server（Express + TS，:14001）
          │
      ┌───┴───────────────────────────┐
      ▼                               ▼
 MySQL：pt_carpool（22 张表）       Redis
（双连接池，均指向同一库）      （验证码 / refresh token /
                                     到账锁 / token 黑名单 / 余额缓存）
      │
      └─ 模型调用 / 短信 / 邮件 / 支付由对应外部服务完成
```

### 数据层：统一库 `pt_carpool`

数据库 `pt_carpool`（建库建表脚本见 `sql/pt_carpool.sql`）共 **21 张表**，分两组：

**模型 / 渠道 / 令牌 / 计费类**（11 张）：

```
endpoint / model_library / model_price_tiers / model_prices / price_tier_time_ranges /
provider_capabilities / proxy_channel_models / proxy_channel_tokens / proxy_channels /
proxy_logs / proxy_tokens
```

**拼车业务类**（10 张，`pt_*` 前缀）：

```
pt_admins / pt_idempotent_keys / pt_payment_tasks / pt_payments / pt_recharge_tiers /
pt_ride_group_models / pt_ride_groups / pt_ride_members / pt_rides / pt_users
```

服务启动时按职责建立**两个连接池**：一个面向模型 / 渠道 / 令牌类表，一个面向 `pt_*` 业务表（环境变量 `GATEWAY_DB` / `CARPOOL_DB`），当前两者均配置为 `pt_carpool`。与其它服务共用同一 Redis 实例时，拼车业务 key 统一加 `pt:` 前缀（如 `pt:auth:code:{phone}`），避免冲突。

---

## 核心功能

### 认证与开户

- 手机号 + 短信验证码、邮箱 + 邮箱验证码两条通道；**未注册自动开户**（建 `pt_users` + 默认 API Key）。
- 验证码存 Redis（5 分钟有效），发送接口 60 秒冷却防轰炸。
- 登录 / 邮箱登录提交前校验 Cloudflare Turnstile（未配置 `TURNSTILE_SECRET_KEY` 时自动放行，便于本地开发）。
- 用户 JWT：access token（默认 15m）+ refresh token（默认 30d，HttpOnly Cookie）；登出时拉黑 access token、撤销 refresh token。

### 车次拼车（Ride）

- `GET /api/rides` 列表：可上车车次（ACTIVE、未发车、未截止）按最低折扣率升序，另附近 7 天已截止车次。
- `GET /api/rides/:token` 详情（分享页，按 `share_token`）：待上线（PENDING）/ 已取消（CANCELLED）一律 404，前端不可见、不可上车。
- `POST /api/rides/:id/join` 上车：抢名额 + 记录成员 + 激活对应折扣。
- 折扣分组：`pt_ride_groups` / `pt_ride_group_models` 按模型设定折扣倍率，车次详情按组返回（含空闲 / 繁忙时段价）。
- 车次状态机：PENDING（待上线）→ ACTIVE（进行中）→ EXPIRED（到期）/ CANCELLED（发车未成团自动取消）。

### API 令牌与消费

- 用户创建 / 改名 / 启停 / 删除 API Key；列表脱敏，`/reveal` 单独返回明文。
- 消费日志 `proxy_logs`：按模型 / 令牌 / 状态 / 时间筛选，可查看请求 / 响应详情。
- 用量统计按天聚合。

### 充值到账（异步可靠）

1. **下单**：`POST /api/recharge/create` 按档位或自定义金额（`1 元 = 100000 额度`）写入 `pt_payments`（PENDING），返回支付宝扫码内容。
2. **回调**：支付宝回调仅验签 + 记流水（CALLBACK_RECEIVED），不直接改余额；同一订单通过 `pt_idempotent_keys` 幂等。
3. **到账 Worker**（cron 每分钟）：消费 `pt_payment_tasks` 队列，在事务内「加 `pt_users.balance` + 累计充值 → 清 Redis 余额缓存 → 流水置 SUCCESS」；失败指数退避重试（1s→2s→4s→8s），超 5 次置 FAILED 待人工介入；Redis 到账锁防重复入账。
4. **兜底**：`GET /api/recharge/status` 供扫码轮询；下单超 20s 仍待支付时主动查支付宝补漏单；cron 每分钟对账。

### 管理端

- 独立 JWT（`ADMIN_JWT_SECRET`），每个请求回源 `pt_admins` 校验账号仍启用。
- 角色 `SUPER_ADMIN` / `OPERATOR`；发车 / 关闭车次 / 踢人 / 档位与车次的写操作等敏感接口需超管。

---

## API 概览

基础前缀 `/api` 应用限流（`express-rate-limit`：每 15 分钟 1000 次）。响应格式：成功返回 JSON 数据，失败返回 `{ "error": "..." }`（业务错误）。

| 前缀 | 鉴权 | 说明 |
| ---- | ---- | ---- |
| `/api/auth/*` | 部分公开，部分需用户 JWT | 验证码登录 / 注册 / 开户、刷新、登出、资料、密码 |
| `/api/user/*` | 用户 JWT | 资料 / 余额 / 令牌 / 消费日志 / 统计 / 我的车次 / 我的折扣 |
| `/api/rides/*` | 公开读，上车需登录 | 车次列表 / 详情 / 上车 |
| `/api/recharge/*` | 档位公开，其余需登录 | 档位 / 下单 / 订单 / 状态 / 支付宝回调 |
| `/api/admin/*` | 管理员 JWT | 见下方管理端明细 |
| `/api/status`、`/api/notice`、`/api/home_page_content` | 公开 | 平台状态 / 公告 / 自定义首页内容 |
| `/api/pricing/*`、`/api/perf-metrics/*` | 公开 | 模型广场定价 / 繁忙时段价格 / 性能指标 |
| `/api/health` | 公开 | 健康检查（进程信息 / 运行时长） |

### 认证 / 用户端明细

| 方法 & 路径 | 说明 |
| ----------- | ---- |
| POST `/api/auth/send-code` | 发送短信验证码（60s 冷却；开发环境返回 `devCode`） |
| POST `/api/auth/send-email-code` | 发送邮箱验证码 |
| POST `/api/auth/login` | 手机号 + 验证码登录 / 注册 |
| POST `/api/auth/email-login` | 邮箱 + 验证码登录 / 注册 |
| POST `/api/auth/refresh` | 用 HttpOnly `refresh_token` 换取新 access token |
| POST `/api/auth/logout` | 登出（拉黑 access + 撤销 refresh） |
| GET `/api/auth/me` | 当前用户信息 |
| PATCH `/api/auth/profile` | 修改昵称 / 头像 |
| PUT `/api/auth/password` | 设置 / 修改密码（验证码校验手机号） |
| GET `/api/user/profile` | 个人资料 |
| GET `/api/user/balance` | 余额（额度） |
| GET `/api/user/keys` · POST `/api/user/keys` | Key 列表（脱敏）· 创建 |
| GET `/api/user/keys/:id/reveal` | 查看完整 Key（复制用） |
| PATCH `/api/user/keys/:id/name` | 改名 |
| PATCH `/api/user/keys/:id/status` | 启用 / 禁用 |
| DELETE `/api/user/keys/:id` | 删除 |
| GET `/api/user/logs` | 消费日志（筛选 / 分页） |
| GET `/api/user/stats` | 用量统计 |
| GET `/api/user/rides` | 我的车次 |
| GET `/api/user/discounts` | 我的折扣 |

### 车次 / 充值明细

| 方法 & 路径 | 说明 |
| ----------- | ---- |
| GET `/api/rides` | 车次列表（可上车 + 近 7 天已截止） |
| GET `/api/rides/:token` | 车次详情（分享页） |
| POST `/api/rides/:id/join` | 上车 |
| GET `/api/recharge/tiers` | 充值档位（公开） |
| GET `/api/recharge/orders` | 我的充值记录 |
| POST `/api/recharge/create` | 创建充值订单（档位 / 自定义金额） |
| GET `/api/recharge/status?orderNo=` | 订单状态（扫码轮询 / 补漏单） |
| POST `/api/recharge/callback` | 支付宝异步回调（验签 → 记流水 → 入队到账） |

### 管理端明细（需 `Authorization: Bearer <admin_token>`）

| 分组 | 主要接口 |
| ---- | -------- |
| 认证 `/api/admin/auth` | POST `/login`、GET `/me`、POST `/logout`、POST `/password` |
| 用户 `/api/admin/users` | GET `/`、GET `/:id`、GET `/:id/discounts`、POST `/:id/status`、GET `/:id/tokens`、PUT `/:id/tokens/:tokenId/status`、DELETE `/:id/tokens/:tokenId` |
| 渠道 `/api/admin/channels` | GET `/models`、GET `/channels`、GET `/capabilities`、POST `/channels`、PUT / DELETE `/channels/:id`、POST `/channels/:id/test`、POST `/channels/:id/fetch-models` |
| 渠道模型 `/api/admin/channels/:channelId/models` | GET / POST 列表 / 新增、PUT / DELETE `/:id`、PUT `/:id/endpoint`、GET / PUT `/:id/price`、GET / PUT / DELETE `/:id/busy-price` |
| 支付 `/api/admin/payments` | GET `/`、GET `/:id`、POST `/:id/retry`（超管） |
| 统计 `/api/admin/stats` | GET `/overview`、GET `/recharge-trend` |
| 档位 `/api/admin/tiers` | GET `/`、POST `/`、PUT / DELETE `/:id`（写操作需超管） |
| 车次 `/api/admin/rides` | GET `/`、GET `/models`、GET `/:id`、POST `/`、PUT `/:id`、POST `/:id/status`、POST `/:id/close`、POST `/:id/members/:userId/kick`（发车 / 关闭 / 踢人需超管） |
| 日志 `/api/admin/logs` | GET `/`、GET `/request-detail` |
| 令牌 `/api/admin/tokens` | GET `/owners`、GET `/`、POST `/`、PUT / DELETE `/:id`、POST `/:id/reset-quota` |
| 模型 `/api/admin/models` | GET `/`、POST `/`、PUT / DELETE `/:modelId` |
| 模板 `/api/admin/model-configs` | GET / POST `/model-templates`、PUT / DELETE `/model-templates/:id` |

> 各接口的请求 / 响应结构以代码为准（`src/routes/**`）。

---

## 定时任务（`src/cron`）

| 频率 | 任务 | 说明 |
| ---- | ---- | ---- |
| 每分钟 | 充值到账 Worker | 消费 `pt_payment_tasks`：事务内加余额 + 累计充值 → 清 Redis 缓存 → 流水置 SUCCESS；失败退避重试，超 5 次置 FAILED |
| 每分钟 | 充值对账 | 查 5 分钟前仍未支付订单，主动查支付宝，已支付则补录到账（`PAYMENT_DRY_RUN` 下跳过） |
| 每分钟 | 发车处理 | 成团补种 `established_at`；发车时间到仍未成团 → CANCELLED |
| 每 5 分钟 | 到期车次 | `end_time` 已过且 ACTIVE → EXPIRED |
| 每 5 分钟 | 活跃度回收 | 30 天（`RIDE_INACTIVE_DAYS`）无消费的成员请出，撤销折扣、释放名额 |

---

## 快速开始

前置：Node.js ≥ 20、MySQL、Redis。

```bash
# 1. 安装依赖
npm install

# 2. 建库建表（21 张表，含默认充值档位）
mysql -uroot -p --host=127.0.0.1 < sql/pt_carpool.sql

# 3. 配置环境变量
cp .env.example .env.development     # 按需修改
#    必填：REDIS_URL
#    必填：JWT_SECRET / REFRESH_TOKEN_SECRET / ADMIN_JWT_SECRET（≥16 位）
#    可选：支付宝 / 短信 / 邮件 / Turnstile（不配置则走降级路径，见「开发联调」）

# 4. 创建管理员（默认 admin；不传密码则生成随机密码并打印一次）
npm run seed -- admin admin123456

# 5. 启动（NODE_ENV=development → 加载 .env.development）
npm run start:dev

# 6. 健康检查
curl http://127.0.0.1:14001/api/health
```

启动时校验 MySQL 两个连接池与 Redis 连通性，成功后打印监听地址并启动定时任务。

### 环境变量加载顺序

`NODE_ENV`（默认 `development`）决定加载顺序，先加载的优先级高：

```
.env.{NODE_ENV}.local  →  .env.{NODE_ENV}  →  .env.local  →  .env
```

---

## Docker 部署

本仓库提供**生产多阶段镜像**（`npm ci` → tsc 编译 → 只装生产依赖跑 `node dist/index.js`，非 root 运行）与 docker-compose 编排（**仅后端**；MySQL / Redis 用外部实例，经环境变量连接，与网关共用）。

```bash
# 1. 准备环境变量（真实密钥只放本地 .env.docker，已被 .gitignore 忽略，不提交）
cp .env.docker.example .env.docker
#    编辑 .env.docker：MYSQL_HOST / REDIS_URL 指向外部 MySQL/Redis，
#    JWT_SECRET 等密钥改为 ≥16 位随机串；HOST 必须为 0.0.0.0

# 2. 构建并启动
docker compose up -d --build

# 3. 查看状态 / 日志 / 停止
docker compose ps
docker compose logs -f backend
docker compose down

# 单独构建镜像运行（不用 compose）
docker build -t pinche-backend .
docker run -d -p 14001:14001 --env-file .env.docker --name pinche-backend pinche-backend

# 4. 健康检查
curl http://localhost:14001/api/health
```

**Docker 关键环境变量**：

| 变量 | 必填 | 说明 |
| ---- | ---- | ---- |
| `HOST` | 是 | 必须 `0.0.0.0`（代码默认 `127.0.0.1`，容器内不设则端口映射后访问不到） |
| `REDIS_URL` | 是 | 缺失则启动直接报错；本机 Docker 用 `redis://host.docker.internal:6379` |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` | 是 | 指向外部 MySQL；本机 Docker 用 `host.docker.internal`，服务器用实际 IP |
| `GATEWAY_DB` / `CARPOOL_DB` | 是 | 必须 `pt_carpool`（代码默认 `GATEWAY_DB=silievo`，不设会连错库名） |
| `JWT_SECRET` / `REFRESH_TOKEN_SECRET` / `ADMIN_JWT_SECRET` | 是 | ≥16 位随机串 |
| `CORS_ORIGIN` | 按需 | 线上前端实际地址 |

> 镜像内以非 root 用户运行；`HEALTHCHECK` 每 30s 探测 `/api/health`。真实密钥只存在于本地 `.env.docker`；`.dockerignore` 已排除 `.env*`、`admin_token.txt`，密钥不会进入镜像或构建上下文。

---

## 脚本

| 命令 | 说明 |
| ---- | ---- |
| `npm run dev` | 开发热重载（tsx watch，NODE_ENV=development） |
| `npm run start:dev` | 开发启动（tsx） |
| `npm run build` | 编译到 `dist/`（tsc） |
| `npm run start` | 生产启动（NODE_ENV=production → `.env.production`，运行 `dist/index.js`） |
| `npm run typecheck` | 类型检查（tsc --noEmit） |
| `npm run seed` | 初始化：建管理员 + 幂等默认充值档位（30 / 50 / 100 / 200 元） |

---

## 环境变量

> `.env*` 文件均已加入 `.gitignore`，含真实密钥的环境文件**严禁提交**。完整模板见 `.env.example`。

### 服务

| 变量 | 说明 | 默认 |
| ---- | ---- | ---- |
| `NODE_ENV` | 运行环境（development / production） | `development` |
| `PORT` | 监听端口 | `14001` |
| `HOST` | 监听地址 | `127.0.0.1` |
| `CORS_ORIGIN` | 允许的前端来源，逗号分隔 | `http://localhost:3000` |
| `LOG_LEVEL` | 日志级别 | — |
| `RIDE_INACTIVE_DAYS` | 活跃度回收阈值（天） | `30` |

### MySQL / Redis

| 变量 | 说明 | 默认 |
| ---- | ---- | ---- |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` | 连接信息（两个连接池共用） | `localhost` / `3306` / `root` / `123456` |
| `MYSQL_POOL_SIZE` | 连接池大小 | `10` |
| `GATEWAY_DB` | 模型 / 渠道 / 令牌类表所在库 | `pt_carpool` |
| `CARPOOL_DB` | `pt_*` 业务表所在库 | `pt_carpool` |
| `REDIS_URL` | Redis 连接串（**必填**，缺失拒绝启动） | — |

### 认证

| 变量 | 说明 | 默认 |
| ---- | ---- | ---- |
| `JWT_SECRET` | 用户 access token 密钥（≥16 位） | 必填 |
| `JWT_EXPIRES_IN` | access token 有效期 | `15m` |
| `REFRESH_TOKEN_SECRET` | refresh token 密钥（≥16 位） | 必填 |
| `REFRESH_TOKEN_EXPIRES_IN` | refresh token 有效期 | `30d` |
| `ADMIN_JWT_SECRET` | 管理端 JWT 密钥（≥16 位） | 必填 |
| `ADMIN_JWT_EXPIRES_IN` | 管理端 JWT 有效期 | `7d` |

### 短信 / 邮件 / 人机验证

| 变量 | 说明 |
| ---- | ---- |
| `SMS_PROVIDER` | 短信服务商（`aliyun`） |
| `ALIYUN_SMS_ACCESS_KEY_ID` / `ALIYUN_SMS_ACCESS_KEY_SECRET` / `ALIYUN_SMS_SIGN_NAME` / `ALIYUN_SMS_TEMPLATE_CODE` | 阿里云短信 4 项配置；配置齐全才真实下发 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` / `SMTP_FROM_NAME` / `SMTP_FROM_ADDRESS` | 邮箱验证码（SMTP） |
| `TURNSTILE_SITE_KEY` | Turnstile 站点 key（经 `/api/status` 下发给前端） |
| `TURNSTILE_SECRET_KEY` | Turnstile 校验密钥（未配置则跳过人机验证） |

### 支付（支付宝）

| 变量 | 说明 |
| ---- | ---- |
| `ALIPAY_APP_ID` / `ALIPAY_APP_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` | 支付宝应用凭证 |
| `ALIPAY_GATEWAY` | 支付宝网关地址 |
| `ALIPAY_NOTIFY_URL` / `PAYMENT_NOTIFY_BASE_URL` | 回调地址（需公网可达） |
| `PAYMENT_DRY_RUN` | `true` 时走 mock 二维码，不发起真实支付（本地联调用） |

### 系统

| 变量 | 说明 |
| ---- | ---- |
| `SYSTEM_NAME` / `SYSTEM_LOGO` | 平台名称 / Logo（经 `/api/status` 下发） |
| `SYSTEM_NOTICE` | 平台公告内容 |
| `SYSTEM_HOME_PAGE_CONTENT` | 自定义首页内容 |

---

## 目录结构

```
carpool/server/
├── src/
│   ├── config/         env 加载器 + 双 MySQL 连接池
│   ├── middlewares/    userAuth / adminAuth（含 requireSuperAdmin）
│   ├── routes/         auth / user / rides / recharge / admin / system
│   ├── services/       user / token / onboarding / ride / payment(alipay, credit)
│   ├── utils/          redis / jwt / auth-session / sms / mailer / turnstile / logger
│   ├── cron/           定时任务（到账 / 对账 / 发车 / 到期 / 活跃度回收）
│   └── index.ts        统一入口
├── scripts/seed.ts     初始化：管理员 + 默认充值档位
├── sql/pt_carpool.sql  建库建表脚本（21 张表）
└── package.json
```

---

## 开发联调

- **验证码**：开发环境短信 / 邮件发送成功后在服务端日志打印验证码，且 `send-code` / `send-email-code` 直接返回 `devCode`，可免真实发送直接登录。
- **支付**：`PAYMENT_DRY_RUN=true` 时下单返回 mock 二维码；如需验证回调到账，可手动 POST 模拟：
  ```bash
  curl -X POST http://127.0.0.1:14001/api/recharge/callback \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "out_trade_no=PT...&trade_no=MOCK&total_amount=10.00&trade_status=TRADE_SUCCESS"
  ```
  到账由 cron 每分钟消费 `pt_payment_tasks`，余额 + 额度后清理 Redis `user_balance:{userId}` 缓存。

---

## English

# Token Carpool Platform · Backend (carpool/server)

Unified backend for the **Token Carpool (quota-sharing) Platform**. A single Express + TypeScript process serves the **user console**, **admin console**, and **system APIs** — accounts, rides, API keys, usage logs, recharge, and model pricing.

Frontend: `carpool/web` (React + Rsbuild, :3000).

## Overview

Model calls are billed by token quota. Users form **Rides (车次)** to share discounted model pricing once the minimum member count is reached. Admins create rides, configure discount groups per model, and manage membership.

- **User**: phone/email verification-code sign-in (auto-provisioning), profile, balance (quota), API key management, usage logs, my rides, my discounts, recharge.
- **Admin** (`/api/admin/*`): admin login, user management, ride management (members / discount groups / status), channels & models, tokens, payments, stats, log details, recharge tiers.
- **System**: `/api/status`, `/api/notice`, `/api/home_page_content`, `/api/pricing`, `/api/perf-metrics`, `/api/health`.

## Tech Stack

TypeScript · Node.js ≥ 20 · Express 4 · MySQL (mysql2 pools) · Redis (ioredis) · JWT (user + admin) · express-validator + zod · bcryptjs · alipay-sdk · Aliyun SMS (native fetch) · nodemailer · Cloudflare Turnstile · node-cron · helmet / cors / express-rate-limit.

## Architecture

```
Browser / frontend (carpool/web, :3000)
          │  CORS → /api/*
          ▼
   carpool/server (Express + TS, :14001)
          │
      ┌───┴───────────────────────────┐
      ▼                               ▼
 MySQL: pt_carpool (21 tables)     Redis
(2 pools, both → pt_carpool)   (codes / refresh tokens /
                                        locks / blacklist / balance cache)
```

The single database **`pt_carpool`** holds 21 tables in two groups:

- **Model / channel / token / billing** (11): `endpoint`, `model_library`, `model_price_tiers`, `model_prices`, `price_tier_time_ranges`, `provider_capabilities`, `proxy_channel_models`, `proxy_channel_tokens`, `proxy_channels`, `proxy_logs`, `proxy_tokens`.
- **Carpool business** (`pt_*`, 10): `pt_admins`, `pt_idempotent_keys`, `pt_payment_tasks`, `pt_payments`, `pt_recharge_tiers`, `pt_ride_group_models`, `pt_ride_groups`, `pt_ride_members`, `pt_rides`, `pt_users`.

Two connection pools are created at startup — one for model/channel/token tables (`GATEWAY_DB`), one for `pt_*` business tables (`CARPOOL_DB`); both currently point to `pt_carpool`. Business Redis keys are prefixed `pt:` to avoid collisions with other services.

## Highlights

- **Auth**: phone SMS + email verification codes; sign-in auto-provisions an account (creates `pt_users` + default API key). Codes in Redis (5 min), 60 s cooldown. Cloudflare Turnstile on login (skipped if `TURNSTILE_SECRET_KEY` unset). User JWT: access (default 15m) + refresh (default 30d, HttpOnly cookie); logout blacklists the access token.
- **Rides**: `GET /api/rides` (joinable, ordered by lowest discount rate + recently ended), `GET /api/rides/:token` detail (PENDING/CANCELLED are 404 — never visible to users), `POST /api/rides/:id/join`. Discount groups via `pt_ride_groups` / `pt_ride_group_models`. Status: PENDING → ACTIVE → EXPIRED / CANCELLED.
- **Recharge (async & reliable)**: order → `pt_payments` (PENDING) → Alipay QR code; callback only verifies signature + records payment (`pt_idempotent_keys` for idempotency); a cron worker consumes `pt_payment_tasks` to credit `pt_users.balance` + clear the Redis balance cache, with exponential backoff (max 5 retries → FAILED) and a Redis lock against double-crediting. Reconciliation + an order-status endpoint cover missed callbacks.
- **Admin**: separate JWT (`ADMIN_JWT_SECRET`), per-request re-check of `pt_admins`; `SUPER_ADMIN` / `OPERATOR` roles; sensitive actions (ride launch/close/kick, tier & ride writes) require super admin.

## Cron Jobs (`src/cron`)

| Freq | Job |
| ---- | --- |
| 1 min | Credit worker (consume `pt_payment_tasks`) |
| 1 min | Recharge reconciliation (query Alipay for unpaid orders >5 min) |
| 1 min | Departure handling (set `established_at`, cancel un-formed rides) |
| 5 min | Expire rides past `end_time` (ACTIVE → EXPIRED) |
| 5 min | Kick inactive members (`RIDE_INACTIVE_DAYS`, default 30) |

## Getting Started

```bash
npm install
mysql -uroot -p --host=127.0.0.1 < sql/pt_carpool.sql
cp .env.example .env.development        # edit as needed
npm run seed -- admin admin123456       # create admin
npm run start:dev                       # http://127.0.0.1:14001
curl http://127.0.0.1:14001/api/health
```

Required env: `REDIS_URL`, `JWT_SECRET`, `REFRESH_TOKEN_SECRET`, `ADMIN_JWT_SECRET` (≥16 chars). `.env*` files are gitignored — never commit real credentials.

**Env loading order** (highest first): `.env.{NODE_ENV}.local` → `.env.{NODE_ENV}` → `.env.local` → `.env`. `NODE_ENV` defaults to `development`.

## Scripts

`dev` (tsx watch) · `start:dev` (tsx) · `build` (tsc) · `start` (production, `dist/index.js`) · `typecheck` (tsc --noEmit) · `seed` (admin + default recharge tiers).

## Dev Tips

- Verification codes are printed to the server log in dev; `send-code` / `send-email-code` also return `devCode` for local sign-in.
- Payments: set `PAYMENT_DRY_RUN=true` for a mock QR code; simulate the callback with a manual `POST /api/recharge/callback` to exercise the credit pipeline.

## Directory

```
src/config     env loader + dual MySQL pools
src/middlewares userAuth / adminAuth (requireSuperAdmin)
src/routes     auth / user / rides / recharge / admin / system
src/services   user / token / onboarding / ride / payment(alipay, credit)
src/utils      redis / jwt / auth-session / sms / mailer / turnstile / logger
src/cron       scheduled jobs
scripts/seed.ts
sql/pt_carpool.sql
```

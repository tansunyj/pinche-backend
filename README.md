# Token 拼车平台 - 统一后端（carpool/server）

融合自老 `website_backend` + `admin_backend`，单进程同时服务**普通用户端**与**管理端**，
并新增**拼车业务**。网关（Java）**零改动**——拼车程序直连网关 MySQL + Redis。

## 架构一览

```
用户/管理员 → carpool/server (Express, :14001)
                ├── gatewayPool → 并入网关表的 pt_carpool
                │                 users / proxy_tokens / proxy_logs / proxy_channels / model_library ...
                │                 （user_model_discounts 未并入，仍在 silievo_dev；carpool 已不读写它）
                ├── carpoolPool  → 拼车库 pt_carpool（全部 pt_* 新表）
                └── Redis        → 业务键 pt:* 前缀；唯一耦合点：充值后清 user_balance:{userId}
```

- **新表全部在独立库 `pt_carpool`**（`sql/pt_carpool.sql` 建库建表），网关库零新建、零改动
- **上车 = 抢名额 + 记录成员**：车次只做成员管理，**不读写**网关 `user_model_discounts`
- **充值到账异步可靠**：回调仅验签+记流水 → `pt_payment_tasks` 队列 → cron worker 加余额+清缓存，
  失败指数退避重试，Redis 到账锁防重复

## 快速开始

前置：本地 MySQL + Redis；网关开发库 `silievo_dev` 已就绪。

```bash
npm install
# 1) 建拼车库（独立库 pt_carpool，含默认充值档位 seed）
mysql -uroot -p123456 --host=127.0.0.1 < sql/pt_carpool.sql
# 2) 创建管理员（默认 admin/admin123456）
npm run seed -- admin admin123456
# 3) 启动（NODE_ENV=development → 加载 .env.development）
npm run start:dev
```

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发热重载（tsx watch） |
| `npm run start:dev` | 开发启动 |
| `npm run build` | 编译到 dist |
| `npm run start` | 生产启动（NODE_ENV=production → `.env.production`） |
| `npm run typecheck` | 类型检查 |
| `npm run seed` | 建管理员 + 幂等默认充值档位 |

## 环境变量（.env.development / .env.example）

| 变量 | 说明 |
|------|------|
| `GATEWAY_DB` | 网关库名：开发 `silievo_dev` / 生产 `silievo_prod` |
| `CARPOOL_DB` | 拼车库名 `pt_carpool` |
| `ADMIN_JWT_SECRET` | 管理端 JWT（独立于用户端，≥16 位） |
| `ALIPAY_*` / `PAYMENT_DRY_RUN` | 支付宝；未配置或 `PAYMENT_DRY_RUN=true` 走 mock 二维码 |
| `CORS_ORIGIN` | 前端地址（逗号分隔） |

## 接口前缀

| 前缀 | 鉴权 | 说明 |
|------|------|------|
| `/api/auth/*` | 用户 JWT（部分公开） | 手机号验证码登录/注册即开户 |
| `/api/user/profile,balance,keys,logs,stats` | 用户 JWT | 用户端基础能力 |
| `/api/user/rides,discounts` | 用户 JWT | 我的车次 / 我的折扣 |
| `/api/rides/*` | 公开读 + 上车需登录 | 车次列表/详情/上车 |
| `/api/recharge/tiers,create,callback` | create 需登录 | 充值档位/下单/支付宝回调 |
| `/api/admin/*` | 管理员 JWT | 认证/用户/渠道/流水/统计/档位/车次 |

## 开发联调

- 短信验证码：开发环境 `send-code` 直接返回 `devCode`，用其登录即可
- 支付：`PAYMENT_DRY_RUN=true` 时下单返回 mock 二维码，回调可手动 POST 模拟：
  ```bash
  curl -X POST http://127.0.0.1:14001/api/recharge/callback \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "out_trade_no=PT...&trade_no=MOCK&total_amount=10.00&trade_status=TRADE_SUCCESS"
  ```
  到账由 cron 每分钟消费 `pt_payment_tasks`，余额+额度后清理 Redis `user_balance:{userId}`

## 目录

```
src/
  config/     env / db（双连接池）/ 启动连接检查
  utils/      redis / jwt / auth-session / sms
  middlewares/ userAuth / adminAuth
  services/   user / token / onboarding / ride / payment(alipay,credit)
  routes/     auth / user / rides / recharge / admin
  cron/       到账 worker / 对账 / 到期车次 / 活跃度回收
  index.ts    统一入口
sql/pt_carpool.sql   拼车库建表 + 默认档位
legacy/       老 website_backend + admin_backend（移植素材，勿运行）
```

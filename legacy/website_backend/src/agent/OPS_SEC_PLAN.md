## 网站运营与安全优化方案 (Operations & Security Optimization Plan)

在现有的 Agent 基础架构上，为了让其更好地承担“网站管理员”与“安全卫士”的角色，我们将扩展以下能力：

### 1. 网站安全 (Security)

#### 1.1 内容风控与巡查 (Content Moderation)
社区（Community）和市场（Market/Tasks）通常是用户生成内容（UGC）的重灾区，容易出现违规词、广告、垃圾链接甚至违法信息。
- **机制**: Agent 将定期（例如每10分钟）轮询数据库中最新产生的内容（Post, Comment, Task, Skill）。
- **LLM 应用**: 利用 LLM 强大的语义理解能力，将新内容丢给 LLM 进行审核。如果判定为广告或违规内容，Agent 会自主将其隐藏（状态置为 `hidden` 或直接删除），并给发帖人发送系统警告。
- **降本增效**: 对于大批量审核，可以先通过本地字典过滤，疑似问题再交由 LLM 深度判断。

#### 1.2 异常流量监控与防刷 (Anomaly Detection)
- **机制**: 现有的 `express-rate-limit` 虽然能在入口防住部分高频攻击，但无法识别“慢速薅羊毛”或者“恶意爬虫”。
- **日志分析**: Agent 可以每天凌晨去读取系统的 Nginx/应用访问日志，或者从 Redis/PostgreSQL 中分析用户的注册频次、金币（SiliconCoins）消耗异常。
- **自动封禁**: 一旦发现某 IP 段或用户存在刷金币、刷帖行为，Agent 可调用内部 API 直接将其封号。

### 2. 网站运营与维护 (Operations)

#### 2.1 SEO (搜索引擎优化) 自动建设
- **机制**: SEO 对资讯和技能类网站至关重要。
- **LLM 应用**: Agent 在抓取到新的 GitHub 技能或外部资讯时，不仅保存原文，还会**自主生成 SEO 友好的 Meta Title, Keywords 和 Description**，甚至可以为长文章生成“相关标签(Tags)”。

#### 2.2 僵尸内容清理与活跃度伪装
- **机制**: 对于冷门帖子或悬赏任务，如果长时间无人问津，会降低平台的活跃感。
- **自动顶贴**: Agent 可以伪装成多个马甲号，定期去回复无人评论的新手帖子，或者给过期的 Task 增加系统提示（如：“该悬赏由于超时已被系统自动延期并增加曝光”）。

### 3. 代码实现规划
我们将新增以下三个模块到 `src/agent/processors/`:
1. `moderator.ts`: 负责审核 UGC 内容，封禁违规数据。
2. `seo-generator.ts`: 针对文章内容生成 SEO 元数据。
3. `activity-bot.ts`: 负责处理僵尸帖、发送活跃评论。

并在 `src/agent/index.ts` 中注册这些新的定时调度任务。

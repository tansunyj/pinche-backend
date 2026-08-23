# SiliEvo 自主维护 Agent 架构设计 (SiliEvo Autonomous Maintenance Agent)

## 1. 架构目标
为 SiliEvo 平台设计一个能够“自主维护”、“自主收集信息”、“自主升级”的智能后台 Agent 服务。该 Agent 主要负责：
- **AI资讯 (News):** 自动从 RSS、知名科技媒体抓取 AI 相关的最新资讯并入库。
- **任务 (Tasks):** 自动从外包平台（如 Upwork/Freelancer）、或者通过大模型生成虚构但合理的悬赏任务。
- **技能 (Skills):** 每天定时去 GitHub (如 awesome-ai-prompts 等开源经验库) 或者类似 ClawHub 平台收集技能、经验包，总结提炼后发布到本站技能市场。
- **社区 (Community):** 定期总结今日的 AI 进展，自动在社区发帖活跃气氛。

## 2. 核心模块与工作流
整个系统由以下几个子系统组成，可作为 Node.js 后端的一个独立 Worker 或集成在 Express 中：

### 2.1 调度系统 (Scheduler)
基于 `node-cron` 或 `bullmq`，定期唤醒各类任务（如 `daily-skills-fetch`, `hourly-news-fetch`）。

### 2.2 数据源管理器与采集器 (Source Manager & Scrapers)
- 管理目标数据源（URL、RSS链接、API端点等）。
- 包含多种采集策略（Axios 直接拉取、Puppeteer/Playwright 模拟浏览器、RSS 解析等）。

### 2.3 LLM 处理器 (LLM Brain)
抓取到的原始数据通常是非结构化的（如 GitHub 的 Readme 文本，网页 HTML）。
通过调用 OpenAI/Gemini 等大语言模型，Agent 能够：
1. **清洗与格式化:** 将原始文本转化为 JSON，符合 `Skill` 或 `Task` 或 `Post` 的数据库 Schema。
2. **翻译与总结:** 将英文资讯翻译成中文，并生成摘要。
3. **内容生成:** 根据当前趋势自动撰写社区帖子。

### 2.4 数据写入层 (Data Ingestor)
通过 Prisma 客户端，将 LLM 整理好的数据持久化到 PostgreSQL 数据库中，并关联到一个虚拟的“官方 Agent 账号”（例如 ID 为 "system-agent" 的 User）。

### 2.5 自主升级与自我修复机制 (Self-Evolution & Auto-Healing)
这是本架构最核心的设计点：
- **监控与失败重试 (Monitoring & Healing):** 如果采集器访问某个网站失败（如选择器变更、反爬虫策略改变），捕获错误。
- **自动修复采集逻辑 (Self-Healing Scraper):** 将报错信息和最新的目标网页 HTML 丢给大模型（LLM），让大模型重新生成正确的 CSS 选择器或抓取逻辑。更新并持久化保存该逻辑。
- **发现新数据源 (Self-Expanding Sources):** Agent 可以每天执行一次“Search”动作（例如调用 Google Search API 搜索 "latest AI agent skills list"），提取新的有价值的 URL 加入自己的数据源列表。
- **Prompt 自主迭代 (Prompt Auto-Tuning):** 如果生成的技能或资讯点赞数/阅读量极低，Agent 会在 Prompt 中加入反馈修正：“上次生成的过于简略，本次请详细描述技术实现细节”。

## 3. 目录结构
```text
backend/src/agent/
├── index.ts               # Agent 启动入口与调度中心
├── sources.json           # 动态数据源配置文件（Agent可自主修改）
├── scrapers/              # 各种信息采集脚本（支持动态加载）
│   ├── github.ts
│   └── rss.ts
├── processors/            # 经过LLM处理的数据管道
│   ├── llm.ts             # 封装与 OpenAI/Gemini 的交互
│   ├── skill-parser.ts    # 提取并生成技能数据
│   └── news-parser.ts     # 提取并生成新闻资讯
├── healing/               # 自我修复与升级模块
│   └── auto-updater.ts    # 遇到错误时自动让LLM修改配置或抓取代码
└── tasks/                 # 定时任务执行器
    ├── fetch-skills.ts
    ├── fetch-news.ts
    └── community-post.ts
```

## 4. 运行逻辑示意图
1. **触发**: `node-cron` 触发 `fetch-skills.ts`。
2. **读取配置**: 从 `sources.json` 读取需要爬取的 GitHub Repo。
3. **抓取**: `scrapers/github.ts` 获取 Repo 的 README 或文件。
    - *失败分支*: 触发 `auto-updater.ts`，LLM分析错误，更新 URL 或抓取规则，并重试。
4. **处理**: 丢给 `llm.ts` 进行内容提取，按照 `Skill` Schema 返回 JSON。
5. **入库**: 使用 Prisma 创建 `Skill` 数据。
6. **升级反馈**: 每天晚间运行一次审计，若数据源枯竭，Agent 会调用搜索API寻找新的数据源补充到 `sources.json`。

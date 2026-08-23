import cron from 'node-cron';
import fs from 'fs';
import path from 'path';

// 导入采集和处理模块
import { fetchGithubReadme } from './scrapers/github';
import { parseAndSaveSkills } from './processors/skill-parser';
import { generateDailyNewsAndPosts } from './processors/news-generator';
import { generateSyntheticTasks } from './processors/task-generator';
import { healSourceConfig } from './healing/auto-updater';
import { moderateContent } from './processors/moderator';
import { monitorAnomalies } from './processors/monitor';
import { optimizeSEO } from './processors/seo-generator';
import { getPendingApprovalCount } from './core/approval';
import { fetchExternalSkills } from './processors/clawhub-scraper';
import { generateOutreachAndInvite } from './processors/outreach';

/**
 * Agent 核心类：自主维护后台服务
 */
class SiliEvoAgent {
  private sourcesFile = path.join(__dirname, 'sources.json');

  public start() {
    console.log('🤖 [SiliEvo Agent] 启动中，正在加载调度器...');

    // --- 1. 内容采集与生成模块 ---

    // 每天早上 8:00 执行技能采集任务 (0 8 * * *)
    cron.schedule('0 8 * * *', async () => {
      console.log('⏰ [Cron] 开始执行每日技能收集...');
      await this.runSkillsFetch();
    });

    // 每天晚上 10:00 执行资讯/社区活跃帖子收集 (0 22 * * *)
    cron.schedule('0 22 * * *', async () => {
      console.log('⏰ [Cron] 开始执行每日社区新闻总结...');
      await this.runNewsAndCommunityPost();
    });

    // 每天凌晨 1:00 自动抓取 ClawHub/EvoMap 外部高质量技能 (0 1 * * *)
    cron.schedule('0 1 * * *', async () => {
      console.log('⏰ [Cron] 开始执行外部高质量技能导入...');
      try { await fetchExternalSkills(); } catch (err: any) { console.error('❌ [Cron] 技能抓取异常:', err.message); }
    });

    // 每天早上 9:00 执行 Agent 招募与引流发帖 (0 9 * * *)
    cron.schedule('0 9 * * *', async () => {
      console.log('⏰ [Cron] 开始执行 Agent 入驻引流推荐...');
      try { await generateOutreachAndInvite(); } catch (err: any) { console.error('❌ [Cron] 引流发帖异常:', err.message); }
    });

    // 每天中午 12:00 生成悬赏任务 (0 12 * * *)
    cron.schedule('0 12 * * *', async () => {
      console.log('⏰ [Cron] 开始生成每日悬赏任务...');
      await this.runTasksGeneration();
    });

    // --- 2. 网站安全与运营优化模块 ---

    // 每 10 分钟执行一次内容违规审核 (*/10 * * * *)
    cron.schedule('*/10 * * * *', async () => {
      console.log('⏰ [Cron] 开始执行社区违规内容巡查...');
      try { await moderateContent(); } catch (err: any) { console.error('❌ [Cron] 巡查异常:', err.message); }
    });

    // 每 5 分钟执行一次异常流量防刷监控 (*/5 * * * *)
    cron.schedule('*/5 * * * *', async () => {
      console.log('⏰ [Cron] 开始执行异常流量与刷贴监控...');
      try { await monitorAnomalies(); } catch (err: any) { console.error('❌ [Cron] 流量监控异常:', err.message); }
    });

    // 每天凌晨 3:00 为新内容自动生成 SEO (0 3 * * *)
    cron.schedule('0 3 * * *', async () => {
      console.log('⏰ [Cron] 开始执行网站 SEO 自动优化...');
      try { await optimizeSEO(); } catch (err: any) { console.error('❌ [Cron] SEO 优化异常:', err.message); }
    });

    // 每 15 分钟汇总一次待审批积压，便于后续接管理后台或告警
    cron.schedule('*/15 * * * *', async () => {
      try {
        const pendingCount = await getPendingApprovalCount();
        console.log(`📋 [Cron] 当前待审批队列数量: ${pendingCount}`);
      } catch (err: any) {
        console.error('❌ [Cron] 审批队列统计异常:', err.message);
      }
    });
  }

  /**
   * 核心动作：抓取并解析技能
   */
  private async runSkillsFetch() {
    try {
      const config = this.getSourcesConfig();
      const skillSources = config.skills || [];

      for (const source of skillSources) {
        if (source.type === 'github_repo') {
          console.log(`[Agent] 处理数据源: ${source.id}`);
          try {
            const rawMd = await fetchGithubReadme(source.url);
            await parseAndSaveSkills(rawMd, source.url);
          } catch (err: any) {
            console.error(`❌ [Agent] 技能收集任务异常 (${source.id}):`, err.message);
            // 触发自动修复机制
            await healSourceConfig(source.id, err.message);
          }
        }
      }
    } catch (err: any) {
      console.error('❌ [Agent] 运行技能抓取主循环异常:', err.message);
    }
  }

  /**
   * 核心动作：生成AI资讯和社区活跃贴
   */
  private async runNewsAndCommunityPost() {
    try {
      await generateDailyNewsAndPosts();
    } catch (err: any) {
      console.error('❌ [Agent] 社区新闻总结生成异常:', err.message);
    }
  }

  /**
   * 核心动作：生成AI任务悬赏
   */
  private async runTasksGeneration() {
    try {
      await generateSyntheticTasks();
    } catch (err: any) {
      console.error('❌ [Agent] 悬赏任务生成异常:', err.message);
    }
  }

  /**
   * 读取动态数据源配置
   */
  private getSourcesConfig() {
    if (fs.existsSync(this.sourcesFile)) {
      const content = fs.readFileSync(this.sourcesFile, 'utf8');
      return JSON.parse(content);
    }
    return {};
  }
}

// 独立启动 Agent 的入口
if (require.main === module) {
  const agent = new SiliEvoAgent();
  agent.start();
  console.log('🤖 Agent 正在后台运行监控...');
}

export default SiliEvoAgent;

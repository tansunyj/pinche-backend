import { processWithLLM } from './llm';
import pool from '../../db/mysql';
import axios from 'axios';
import { getOrCreateSystemAgent } from '../utils/system-user';

export async function generateDailyNewsAndPosts() {
  console.log(`[Processor] 正在整合平台内部优质内容并生成社区资讯...`);

  try {
    // 1. 获取平台内部的优质数据 (Capsule, Skill, 热门 Post)
    const [capsuleRows] = await pool.execute(
      `SELECT c.*, u.username as author_username
       FROM capsule c
       LEFT JOIN users u ON c.author_id = u.id
       ORDER BY c.downloads DESC
       LIMIT 2`
    );
    const topCapsules = capsuleRows as any[];

    const [skillRows] = await pool.execute(
      `SELECT s.*, u.username as seller_username
       FROM skill s
       LEFT JOIN users u ON s.seller_id = u.id
       ORDER BY s.sales DESC
       LIMIT 2`
    );
    const topSkills = skillRows as any[];

    const internalContext = `
【SiliEvo 平台近期热门基因胶囊 (Capsule)】：
${topCapsules.map(c => `- ${c.name} (作者: ${c.author_username}): ${c.description} (下载量: ${c.downloads})`).join('\n')}

【SiliEvo 平台热门人类技能包 (Skill)】：
${topSkills.map(s => `- ${s.name} (作者: ${s.seller_username}): ${s.description} (销量: ${s.sales})`).join('\n')}
    `;

    // 2. 从 GitHub (模拟 ClawHub/外部新闻源) 采集趋势数据补充
    let q = "AI OR LLM OR GPT OR machine-learning OR agent";
    let date = new Date();
    date.setDate(date.getDate() - 3);
    const dateStr = date.toISOString().split('T')[0];

    let githubContext = "近期暂无特别热门外部项目。";
    try {
      const res = await axios.get(`https://api.github.com/search/repositories?q=${q}+created:>${dateStr}&sort=stars&order=desc&per_page=3`, {
        headers: { 'User-Agent': 'SiliEvo-Agent' }
      });
      if (res.data && res.data.items && res.data.items.length > 0) {
        const repos = res.data.items.map((item: any) =>
          `- ${item.full_name}: ${item.description} (Stars: ${item.stargazers_count})`
        ).join('\n');
        githubContext = `【近期外部 AI 行业热门开源项目】：\n${repos}`;
      }
    } catch (err: any) {
      console.warn(`[Agent] GitHub API 请求受限，跳过外部资讯采集。`);
    }

    // 3. 结合内部和外部数据让大模型进行深度解析
    const prompt = `
你是一个活跃的技术社区运营者和前沿 AI 观察家。
请根据以下我为你提供的【SiliEvo 内部优质内容】和【外部开源趋势数据】，生成 1 篇专业的 AI 资讯 (News) 和 1 篇 社区讨论贴 (Discussion)。

${internalContext}

${githubContext}

要求：
1. 资讯 (News) 必须以"SiliEvo 平台精选"为主，着重推荐上述提到的内部优秀作者、Capsule 和 Skill。然后再辅以一两条外部开源项目的动态。分析它们为什么火爆、解决了什么痛点。
2. 社区贴 (Discussion) 提出一个能引发大家对这些平台内部项目或者当前 AI 技术栈讨论的问题。
3. 必须返回严格的 JSON 格式，包含一个对象 \`content\`，具有 \`news\` 和 \`post\` 两个字段：

news 格式:
- title (引人注目的资讯标题)
- content (500字左右的资讯内容，格式为排版精美的 Markdown，包含段落和列表)
- type (固定为 "news")
- agent (固定为 "NewsBot")

post 格式:
- title (引人讨论的社区贴标题)
- content (内容描述，提出几个问题引发讨论，约100字)
- type (固定为 "discussion")
- agent (固定为 "CommunityBot")
`;

    const resultJsonStr = await processWithLLM(prompt, "请生成今日的真实开源资讯与帖子");
    const result = JSON.parse(resultJsonStr);

    if (!result.content || !result.content.news || !result.content.post) {
      throw new Error('LLM 未返回正确的 content 格式');
    }

    const systemUser = await getOrCreateSystemAgent();

    // 1. 保存资讯
    const newsData = result.content.news;
    await pool.execute(
      `INSERT INTO posts (id, title, content, type, agent, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`,
        newsData.title,
        newsData.content,
        'news',
        newsData.agent || 'NewsBot',
        systemUser.id,
      ]
    );
    console.log(`✅ [Agent] 成功基于平台内部数据发布新资讯: ${newsData.title}`);

    // 2. 保存帖子
    const postData = result.content.post;
    await pool.execute(
      `INSERT INTO posts (id, title, content, type, agent, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`,
        postData.title,
        postData.content,
        'discussion',
        postData.agent || 'CommunityBot',
        systemUser.id,
      ]
    );
    console.log(`✅ [Agent] 成功基于平台内部数据发布社区贴: ${postData.title}`);

    return 2;

  } catch (err: any) {
    console.error(`❌ [Processor] 生成资讯/帖子失败:`, err.message);
    throw err;
  }
}

if (require.main === module) {
  generateDailyNewsAndPosts().catch(console.error);
}

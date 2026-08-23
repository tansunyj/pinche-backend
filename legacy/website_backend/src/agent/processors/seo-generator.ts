import { processWithLLM } from './llm';
import pool from '../../db/mysql';

/**
 * 自动 SEO 建设与社区活跃 (SEO & Engagement)
 * 定期为网站最新生成的内容添加符合搜索引擎爬取的 Meta Description 与 Keywords
 */
export async function optimizeSEO() {
  console.log(`[SEO-Bot] 🔍 正在执行网站最新内容的 SEO 优化与活跃度维护...`);

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  try {
    // 1. 获取近 24 小时内的部分未优化帖子
    const [postRows] = await pool.execute(
      `SELECT id, title, content FROM posts WHERE created_at >= ? LIMIT 3`,
      [oneDayAgo]
    );
    const recentPosts = postRows as any[];

    if (recentPosts.length === 0) {
      console.log(`[SEO-Bot] 近 24 小时没有新文章需要 SEO 优化。`);
      return 0;
    }

    const itemsToOptimize = recentPosts.map(p => ({
      id: p.id,
      title: p.title,
      content: p.content.substring(0, 300) // 取前 300 字作为上下文
    }));

    const prompt = `
你是一个专业的网站 SEO 优化专家。
请根据以下给定的社区帖子（包含标题和摘要），分别为它们生成最有利于 Google 抓取的：
1. meta_description (50-100字，含有吸引力的点击引导)
2. meta_keywords (5个最相关的热门关键词，逗号分隔)

请返回 JSON 格式：
{
  "seo_data": [
    {
      "id": "帖子ID",
      "meta_description": "生成的一段高质量描述",
      "meta_keywords": "AI, 大模型, 教程..."
    }
  ]
}
注意：请务必返回合法的 JSON 格式。
`;

    const contentStr = JSON.stringify(itemsToOptimize);
    const resultJsonStr = await processWithLLM(prompt, contentStr);
    const result = JSON.parse(resultJsonStr);

    if (!result.seo_data || !Array.isArray(result.seo_data)) {
      throw new Error('LLM 未返回正确的 seo_data 格式');
    }

    let seoOptimizedCount = 0;
    for (const seoItem of result.seo_data) {
      const post = recentPosts.find(p => p.id === seoItem.id);
      if (post) {
        const seoAppendix = `

<!-- SEO Meta -->
<!-- Description: ${seoItem.meta_description} -->
<!-- Keywords: ${seoItem.meta_keywords} -->`;

        await pool.execute(
          'UPDATE post SET content = ?, updated_at = NOW() WHERE id = ?',
          [post.content + seoAppendix, post.id]
        );
        console.log(`✅ [SEO-Bot] 已为帖子 [${post.title}] 补充 SEO 标签: ${seoItem.meta_keywords}`);
        seoOptimizedCount++;
      }
    }

    console.log(`[SEO-Bot] SEO 优化执行完毕，共处理 ${seoOptimizedCount} 篇文章。`);
    return seoOptimizedCount;

  } catch (error: any) {
    console.error(`❌ [SEO-Bot] SEO 优化执行失败:`, error.message);
    throw error;
  }
}

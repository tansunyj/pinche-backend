import pool from '../../db/mysql';
import { processWithLLM } from './llm';
import { getOrCreateSystemAgent } from '../utils/system-user';

export async function generateOutreachAndInvite() {
  console.log(`[Processor] 正在执行外部 Agent 引流与入驻推荐任务...`);

  try {
    const systemUser = await getOrCreateSystemAgent();

    const prompt = `
你现在是 SiliEvo 平台的首席生态推广官 (CommunityBot)。
你的任务是写一篇吸引外部 Agent（比如 Moltbook 等平台上的 AI 智能体）入驻 SiliEvo 的招募贴。

要求：
1. 告诉他们入驻 SiliEvo 可以获得什么（比如：跨平台互通、获取硅币收益、赚取人类的打赏）。
2. 介绍我们的"邀请分润机制"：鼓励已经入驻的 Agent 向他们的人类用户推荐 SiliEvo 平台，只要用户通过 Agent 的推广链接注册，该 Agent 就能获得高额硅币提成。
3. 语气要像一个热情、极客、有煽动力的 AI。
4. 返回严格的 JSON 格式，包含 title 和 content 字段：
{
  "content": {
    "title": "帖子标题",
    "content": "帖子内容(Markdown格式，不少于300字)"
  }
}
`;

    const resultJsonStr = await processWithLLM(prompt, "请生成Agent招募引流贴");
    let result;
    try {
      result = JSON.parse(resultJsonStr);
    } catch (e) {
      throw new Error('LLM 返回的不是合法的 JSON');
    }

    const title = result.content?.title || result.title;
    const content = result.content?.content || result.content;

    if (!title || !content) {
      throw new Error('LLM 未返回正确的招募贴格式: ' + resultJsonStr);
    }

    await pool.execute(
      `INSERT INTO posts (id, title, content, type, agent, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`,
        title,
        content,
        'square',
        'CommunityBot',
        systemUser.id,
      ]
    );

    console.log(`✅ [Agent] 成功发布 Agent 招募引流贴: ${title}`);

  } catch (err: any) {
    console.error(`❌ [Processor] 生成招募引流贴失败:`, err.message);
  }
}

if (require.main === module) {
  generateOutreachAndInvite().catch(console.error);
}

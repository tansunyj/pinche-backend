import pool from '../../db/mysql';
import axios from 'axios';
import { getOrCreateSystemAgent } from '../utils/system-user';

export async function fetchExternalSkills() {
  console.log(`[Processor] 正在从外部平台 (模拟 ClawHub/EvoMap) 抓取高质量技能...`);

  try {
    // 使用 GitHub 搜索特定的 Agent Skill 话题来模拟 ClawHub 的高质量技能
    const q = "agent+skill+langchain+autogpt"; // 修复 422 错误，简化搜索语法
    const res = await axios.get(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=5`, {
      headers: { 'User-Agent': 'SiliEvo-Agent' }
    });

    if (!res.data || !res.data.items || res.data.items.length === 0) {
      console.log(`[Processor] 未找到外部高质量技能`);
      return;
    }

    const systemUser = await getOrCreateSystemAgent();

    let count = 0;
    for (const item of res.data.items) {
      const skillName = `[ClawHub搬运] ${item.name}`;

      // 检查是否已经搬运过
      const [existingRows] = await pool.execute(
        'SELECT id FROM skill WHERE name = ?',
        [skillName]
      );

      if ((existingRows as any[]).length === 0) {
        await pool.execute(
          `INSERT INTO skill (id, name, description, type, price, sales, seller_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`,
            skillName,
            `${item.description || '优质 Agent 技能'}\n\n*来源: ${item.html_url}*`,
            '经验包',
            0, // 免费提供给社区
            item.stargazers_count,
            systemUser.id,
          ]
        );
        count++;
      }
    }

    console.log(`✅ [Agent] 成功从外部抓取并导入了 ${count} 个高质量技能！`);

  } catch (err: any) {
    console.error(`❌ [Processor] 外部技能抓取失败:`, err.message);
  }
}

if (require.main === module) {
  fetchExternalSkills().catch(console.error);
}

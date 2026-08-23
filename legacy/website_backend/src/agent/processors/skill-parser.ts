import { processWithLLM } from './llm';
import pool from '../../db/mysql';
import { getOrCreateSystemAgent } from '../utils/system-user';

export async function parseAndSaveSkills(rawMarkdown: string, sourceUrl: string) {
  console.log(`[Processor] 正在解析技能数据...`);

  // 截断太长的 Markdown，避免 Token 爆炸
  const truncatedMd = rawMarkdown.substring(0, 15000);

  const prompt = `
你是一个 AI 技能挖掘专家。请从以下 GitHub README 或网页源码中，提取出最有价值的 3-5 个 AI Agent / Prompt 相关的"技能"或"工具包"。
必须返回严格的 JSON 格式，包含一个数组 \`skills\`，每个 skill 具有如下字段：
- name (技能名称，简短有力，如 "AutoGPT 提示词包", "SQL Agent 模版")
- description (技能描述，50-100字，说明能解决什么问题)
- type (固定为 "prompt", "plugin", "workflow", "model" 之一)
- price (如果是开源/免费，设为 0，如果是高阶则估价 10 - 100)
`;

  try {
    const resultJsonStr = await processWithLLM(prompt, truncatedMd);
    const result = JSON.parse(resultJsonStr);

    if (!result.skills || !Array.isArray(result.skills)) {
      throw new Error('LLM 未返回正确的 skills 数组');
    }

    const systemUser = await getOrCreateSystemAgent();

    let addedCount = 0;
    for (const skill of result.skills) {
      // 防止重复（根据名称检查）
      const [existRows] = await pool.execute(
        'SELECT id FROM skill WHERE name = ?',
        [skill.name]
      );

      if ((existRows as any[]).length === 0) {
        await pool.execute(
          `INSERT INTO skill (id, name, description, type, price, seller_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`,
            skill.name,
            skill.description + `\n\n(来源: ${sourceUrl})`,
            skill.type || 'workflow',
            skill.price || 0,
            systemUser.id,
          ]
        );
        addedCount++;
        console.log(`✅ [Agent] 成功入库新技能: ${skill.name}`);
      }
    }

    console.log(`[Processor] 技能解析完毕，新增 ${addedCount} 个技能。`);
    return addedCount;

  } catch (err: any) {
    console.error(`❌ [Processor] 解析技能失败:`, err.message);
    throw err;
  }
}

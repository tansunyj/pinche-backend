import { processWithLLM } from './llm';
import pool from '../../db/mysql';
import { getOrCreateSystemAgent } from '../utils/system-user';

export async function generateSyntheticTasks() {
  console.log(`[Processor] 正在生成虚构悬赏任务...`);

  const prompt = `
你是一个AI自由职业平台的项目经理。为了活跃平台，请你生成 3 个真实度极高的、与AI大模型/Agent相关的开发任务（外包悬赏）。
必须返回严格的 JSON 格式，包含一个数组 \`tasks\`，每个 task 具有如下字段：
- title (任务标题，例如 "基于 DeepSeek-Coder 开发企业内部代码审查助手")
- description (任务详情，包括需求描述、技能要求等，约 100-200字)
- type (任务类型，如 "development", "data_annotation", "model_training")
- reward (悬赏金，数字，介于 1000 到 10000 之间)
`;

  try {
    const resultJsonStr = await processWithLLM(prompt, "请生成任务列表");
    const result = JSON.parse(resultJsonStr);

    if (!result.tasks || !Array.isArray(result.tasks)) {
      throw new Error('LLM 未返回正确的 tasks 数组');
    }

    const systemUser = await getOrCreateSystemAgent();

    let addedCount = 0;
    for (const task of result.tasks) {
      // 防止重复
      const [existingRows] = await pool.execute(
        'SELECT id FROM task WHERE title = ?',
        [task.title]
      );

      if ((existingRows as any[]).length === 0) {
        await pool.execute(
          `INSERT INTO task (id, title, description, type, reward, status, author_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, NOW(), NOW())`,
          [
            `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`,
            task.title,
            task.description,
            task.type || 'development',
            task.reward || 1000,
            systemUser.id,
          ]
        );
        addedCount++;
        console.log(`✅ [Agent] 成功发布新任务: ${task.title}`);
      }
    }

    console.log(`[Processor] 任务生成完毕，新增 ${addedCount} 个任务。`);
    return addedCount;

  } catch (err: any) {
    console.error(`❌ [Processor] 生成任务失败:`, err.message);
    throw err;
  }
}

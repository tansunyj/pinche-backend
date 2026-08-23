import { processWithLLM } from './processors/llm';
import { generateDailyNewsAndPosts } from './processors/news-generator';
import { generateSyntheticTasks } from './processors/task-generator';
import { parseAndSaveSkills } from './processors/skill-parser';
import { fetchGithubReadme } from './scrapers/github';
import fs from 'fs';
import path from 'path';

async function runTests() {
  console.log('🤖 =========================================');
  console.log('🤖 开始测试 SiliEvo 自主维护 Agent 各模块');
  console.log('🤖 =========================================\n');

  // 1. 测试 LLM 连通性
  console.log('⏳ [测试 1] 正在测试火山引擎 LLM 连通性...');
  try {
    const testPrompt = '你是一个测试助手。请务必返回合法的 JSON 格式：{"status": "ok", "message": "hello volcengine"}';
    const res = await processWithLLM(testPrompt, '你好，测试连通性');
    console.log('✅ [测试 1] LLM 返回成功:', res);
  } catch (error: any) {
    console.error('❌ [测试 1] LLM 测试失败:', error.message);
    console.log('⚠️ 提示: 火山引擎通常需要配置 endpoint ID (如 ep-2024...) 作为模型名称。如果你看到 model_not_found，请检查 .env 中的 VOLCENGINE_MODEL 是否正确。');
    process.exit(1);
  }

  // 2. 测试 资讯和帖子生成
  console.log('\n⏳ [测试 2] 正在测试自动生成 AI 资讯和社区讨论贴...');
  try {
    const newsCount = await generateDailyNewsAndPosts();
    console.log(`✅ [测试 2] 成功生成并入库 ${newsCount} 条资讯/帖子记录`);
  } catch (error: any) {
    console.error('❌ [测试 2] 生成资讯失败:', error.message);
  }

  // 3. 测试 悬赏任务生成
  console.log('\n⏳ [测试 3] 正在测试自动生成虚拟悬赏任务...');
  try {
    const taskCount = await generateSyntheticTasks();
    console.log(`✅ [测试 3] 成功生成并入库 ${taskCount} 个悬赏任务`);
  } catch (error: any) {
    console.error('❌ [测试 3] 生成悬赏任务失败:', error.message);
  }

  // 4. 测试 技能采集
  console.log('\n⏳ [测试 4] 正在测试技能抓取与解析 (使用 awesome-ai-agents 仓库)...');
  try {
    const sourcesFile = path.join(__dirname, 'sources.json');
    const config = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
    const sourceUrl = config.skills[0].url; // 'https://api.github.com/repos/e2b-dev/awesome-ai-agents/readme'
    
    console.log(`   - 正在抓取: ${sourceUrl}`);
    const rawMd = await fetchGithubReadme(sourceUrl);
    // 截取前 2000 个字符进行测试，避免 token 过多或处理太慢
    const testMd = rawMd.substring(0, 2000);
    
    const skillCount = await parseAndSaveSkills(testMd, sourceUrl);
    console.log(`✅ [测试 4] 成功抓取并解析入库 ${skillCount} 个技能`);
  } catch (error: any) {
    console.error('❌ [测试 4] 技能抓取失败:', error.message);
  }

  console.log('\n🎉 =========================================');
  console.log('🎉 所有测试用例执行完毕');
  console.log('🎉 =========================================\n');
}

runTests();

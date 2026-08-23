import { processWithLLM } from '../processors/llm';
import fs from 'fs';
import path from 'path';

/**
 * 自我修复与升级模块 (Self-Healing & Upgrade)
 * 当采集数据源失效或解析失败时触发
 */
export async function healSourceConfig(sourceId: string, errorMsg: string) {
  console.log(`🛠️ [Auto-Healing] 数据源 ${sourceId} 发生异常，启动自动修复机制...`);
  
  const sourcesFile = path.join(__dirname, '..', 'sources.json');
  if (!fs.existsSync(sourcesFile)) {
    console.error('未找到 sources.json，修复终止。');
    return;
  }

  const rawConfig = fs.readFileSync(sourcesFile, 'utf8');
  let config = JSON.parse(rawConfig);

  // 将失败的信息与当前配置发送给大模型，请求生成新的配置或提出修复建议
  const prompt = `
你是系统架构与爬虫修复专家。我们的数据采集 Agent 遇到了错误。
下面是当前的 sources.json 配置：
\`\`\`json
${rawConfig}
\`\`\`
错误发生在数据源 ID 为 \`${sourceId}\` 的任务中。
报错信息如下:
"${errorMsg}"

如果这个源无法访问（例如 404，或者被反爬屏蔽），请你分析原因并提供一个【替代数据源】。
例如如果原本是抓取某个 rss，你可以替换为另一个知名的 AI 资讯 RSS。
如果原本是 GitHub Repo，你可以替换为 \`https://api.github.com/repos/f/awesome-chatgpt-prompts/readme\` 等等。

返回严格 JSON 格式，更新该 source 的字段。你需要返回完整的目标 source 对象：
{
  "id": "${sourceId}",
  "type": "github_repo",
  "url": "新的可用地址",
  "parser": "新的解析器或者保持不变"
}
注意：只返回包含上述格式的 JSON 对象。
`;

  try {
    const newConfigJsonStr = await processWithLLM(prompt, "请修复该数据源配置");
    const newSourceConfig = JSON.parse(newConfigJsonStr);

    if (newSourceConfig.id === sourceId && newSourceConfig.url) {
      console.log(`✅ [Auto-Healing] LLM 生成了修复方案: 替换 URL 为 ${newSourceConfig.url}`);
      
      // 更新源配置
      let updated = false;
      for (const key of Object.keys(config)) {
        if (Array.isArray(config[key])) {
          for (let i = 0; i < config[key].length; i++) {
            if (config[key][i].id === sourceId) {
              config[key][i] = { ...config[key][i], ...newSourceConfig };
              updated = true;
            }
          }
        }
      }

      if (updated) {
        fs.writeFileSync(sourcesFile, JSON.stringify(config, null, 2));
        console.log(`✅ [Auto-Healing] 修复完成，已更新 sources.json，将在下次轮询时生效。`);
      }

    } else {
      console.error(`❌ [Auto-Healing] LLM 返回的格式不正确或未提供新的有效 URL`);
    }

  } catch (err: any) {
    console.error(`❌ [Auto-Healing] 自动修复逻辑执行失败:`, err.message);
  }
}

/**
 * 初始化模型配置数据
 * 运行: node scripts/init-model-configs.js
 */

const { query } = require('../db/init');

async function init() {
  console.log('========== 初始化模型配置 ==========\n');

  // 1. 插入模板
  const templates = [
    {
      key: 'wanx_image',
      name: '万相图片生成',
      desc: '阿里云万相图片生成 API',
      types: '["t2i", "i2i"]',
      endpoint: '/services/aigc/multimodal-generation/generation',
      method: 'POST',
      headers: null,
      response: '{"task_id": "output.task_id", "status": "output.task_status"}',
    },
    {
      key: 'wanx_video',
      name: '万相视频生成',
      desc: '阿里云万相视频生成 API',
      types: '["t2v", "i2v"]',
      endpoint: '/services/aigc/video-generation/video-synthesis',
      method: 'POST',
      headers: '{"X-DashScope-Async": "enable"}',
      response: '{"task_id": "output.task_id", "status": "output.task_status"}',
    },
    {
      key: 'openai_chat',
      name: 'OpenAI 兼容聊天',
      desc: 'OpenAI API 兼容格式',
      types: '["chat", "completion"]',
      endpoint: '/v1/chat/completions',
      method: 'POST',
      headers: null,
      response: '{}',
    },
  ];

  for (const t of templates) {
    try {
      await query(`
        INSERT INTO model_templates
          (template_key, name, description, supported_types, endpoint_path, http_method, headers, response_mapping, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          description = VALUES(description),
          supported_types = VALUES(supported_types),
          endpoint_path = VALUES(endpoint_path),
          http_method = VALUES(http_method),
          headers = VALUES(headers),
          response_mapping = VALUES(response_mapping)
      `, [t.key, t.name, t.desc, t.types, t.endpoint, t.method, t.headers, t.response]);
      console.log(`✅ 模板: ${t.key}`);
    } catch (e) {
      console.error(`❌ 模板 ${t.key} 失败:`, e.message);
    }
  }

  // 2. 获取所有模型和渠道
  const [models] = await query('SELECT model_id FROM model_library WHERE status = 1');
  const [channels] = await query('SELECT id FROM proxy_channels WHERE status = 1 LIMIT 1');

  if (channels.length === 0) {
    console.log('\n⚠️ 没有可用渠道，跳过模型配置');
    process.exit(0);
  }

  const channelId = channels[0].id;

  // 3. 为每个模型创建配置
  console.log('\n创建模型-渠道配置:');

  for (const m of models) {
    const modelId = m.model_id;
    const modelLower = modelId.toLowerCase();

    // 判断模板
    let templateKey = 'openai_chat'; // 默认
    if (modelLower.includes('i2v') || modelLower.includes('t2v')) {
      templateKey = 'wanx_video';
    } else if (modelLower.includes('image') || modelLower.includes('wanx')) {
      templateKey = 'wanx_image';
    }

    // 获取模板ID
    const [tmpl] = await query('SELECT id FROM model_templates WHERE template_key = ?', [templateKey]);
    if (!tmpl || tmpl.length === 0) continue;

    try {
      await query(`
        INSERT INTO model_channel_configs
          (model_id, channel_id, template_id, priority, status)
        VALUES (?, ?, ?, 1, 1)
        ON DUPLICATE KEY UPDATE
          template_id = VALUES(template_id),
          status = 1
      `, [modelId, channelId, tmpl[0].id]);

      console.log(`  ${modelId} -> ${templateKey}`);
    } catch (e) {
      console.error(`  ${modelId} 失败:`, e.message);
    }
  }

  console.log('\n========== 初始化完成 ==========');
  process.exit(0);
}

init().catch(err => {
  console.error('初始化失败:', err);
  process.exit(1);
});
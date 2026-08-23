/**
 * 初始化模型模板数据
 */

const { query } = require('../db/init');

async function initTemplates() {
  console.log('初始化模型模板数据...\n');

  // 1. 插入万相图片生成模板
  try {
    await query(`
      INSERT INTO model_templates (template_key, name, description, supported_types, endpoint_path, http_method, headers, request_body_template, response_mapping)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        supported_types = VALUES(supported_types),
        endpoint_path = VALUES(endpoint_path),
        request_body_template = VALUES(request_body_template),
        response_mapping = VALUES(response_mapping)
    `, [
      'wanx_image',
      '万相图片生成',
      '阿里云万相图片生成 API',
      '["t2i", "i2i"]',
      '/services/aigc/multimodal-generation/generation',
      'POST',
      null,
      JSON.stringify({
        model: '${model}',
        input: {
          messages: [
            {
              role: 'user',
              content: [
                '${if:images}',
                '${foreach:images}',
                { image: '${item}' },
                '${endforeach}',
                '${endif}',
                { text: '${prompt}' }
              ]
            }
          ]
        },
        parameters: {
          size: '${params.size || "2K"}',
          n: '${params.n || 1}',
          watermark: false,
          thinking_mode: true
        }
      }, null, 2),
      JSON.stringify({
        task_id: 'output.task_id',
        status: 'output.task_status',
        results: 'output.results'
      })
    ]);
    console.log('✅ 万相图片生成模板已初始化');
  } catch (e) {
    console.error('❌ 万相图片模板失败:', e.message);
  }

  // 2. 插入万相视频生成模板
  try {
    await query(`
      INSERT INTO model_templates (template_key, name, description, supported_types, endpoint_path, http_method, headers, request_body_template, response_mapping)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        supported_types = VALUES(supported_types),
        endpoint_path = VALUES(endpoint_path),
        headers = VALUES(headers),
        request_body_template = VALUES(request_body_template),
        response_mapping = VALUES(response_mapping)
    `, [
      'wanx_video',
      '万相视频生成',
      '阿里云万相视频生成 API',
      '["t2v", "i2v"]',
      '/services/aigc/video-generation/video-synthesis',
      'POST',
      JSON.stringify({ 'X-DashScope-Async': 'enable' }),
      JSON.stringify({
        model: '${model}',
        input: {
          prompt: '${prompt}',
          media: '${images}'
        },
        parameters: {
          resolution: '${params.resolution || "720P"}',
          duration: '${params.duration || 5}',
          prompt_extend: true,
          watermark: false
        }
      }, null, 2),
      JSON.stringify({
        task_id: 'output.task_id',
        status: 'output.task_status'
      })
    ]);
    console.log('✅ 万相视频生成模板已初始化');
  } catch (e) {
    console.error('❌ 万相视频模板失败:', e.message);
  }

  // 3. 为现有模型创建渠道配置
  console.log('\n初始化模型-渠道配置...');

  // 获取所有模型
  const models = await query('SELECT model_id, category FROM model_library WHERE status = 1');

  // 获取所有渠道
  const channels = await query('SELECT id FROM proxy_channels WHERE status = 1 LIMIT 1');

  if (channels.length === 0) {
    console.log('⚠️ 没有可用的渠道，跳过配置创建');
    return;
  }

  const channelId = channels[0].id;

  for (const model of models) {
    const modelId = model.model_id;
    const modelLower = modelId.toLowerCase();

    // 根据模型特征匹配模板
    let templateKey = null;
    if (modelLower.includes('i2v') || modelLower.includes('t2v')) {
      templateKey = 'wanx_video';
    } else if (modelLower.includes('image') || modelLower.includes('wanx')) {
      templateKey = 'wanx_image';
    }

    if (!templateKey) continue;

    // 获取模板ID
    const templates = await query('SELECT id FROM model_templates WHERE template_key = ?', [templateKey]);
    if (templates.length === 0) continue;

    const templateId = templates[0].id;

    try {
      await query(`
        INSERT INTO model_channel_configs (model_id, channel_id, template_id, priority, status)
        VALUES (?, ?, ?, 1, 1)
        ON DUPLICATE KEY UPDATE
          template_id = VALUES(template_id),
          status = 1
      `, [modelId, channelId, templateId]);

      console.log(`✅ ${modelId} -> ${templateKey}`);
    } catch (e) {
      console.error(`❌ ${modelId} 配置失败:`, e.message);
    }
  }

  console.log('\n初始化完成！');
  process.exit(0);
}

initTemplates().catch(err => {
  console.error('初始化失败:', err);
  process.exit(1);
});
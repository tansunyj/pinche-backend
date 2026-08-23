/**
 * 模型配置管理器 - 完整版
 * 支持：图片生成、视频生成、文本聊天
 */

const { query } = require('../db/init');

class ModelConfigManager {
  constructor() {
    this.configCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5分钟缓存
  }

  /**
   * 获取模型 API 配置
   */
  async getModelApiConfig(modelId) {
    const cacheKey = modelId;
    const cached = this.configCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.data;
    }

    // 1. 先查数据库中的配置
    const config = await this.getDbConfig(modelId);
    if (config) {
      this.configCache.set(cacheKey, { data: config, timestamp: Date.now() });
      return config;
    }

    // 2. 数据库没有，根据模型特征自动判断
    const autoConfig = this.getAutoConfig(modelId);
    this.configCache.set(cacheKey, { data: autoConfig, timestamp: Date.now() });
    return autoConfig;
  }

  /**
   * 从数据库读取配置
   */
  async getDbConfig(modelId) {
    try {
      const rows = await query(`
        SELECT
          mcc.*,
          mt.endpoint_path,
          mt.http_method,
          mt.headers,
          mt.response_mapping,
          mt.supported_types
        FROM model_channel_configs mcc
        JOIN model_templates mt ON mcc.template_id = mt.id
        WHERE mcc.model_id = ? AND mcc.status = 1 AND mt.status = 1
        ORDER BY mcc.priority ASC
        LIMIT 1
      `, [modelId]);

      if (rows.length === 0) return null;

      const r = rows[0];
      return {
        modelId,
        endpoint: r.override_endpoint && r.custom_endpoint_path
          ? r.custom_endpoint_path
          : r.endpoint_path,
        method: r.http_method || 'POST',
        headers: this.parseJson(r.headers),
        responseMapping: this.parseJson(r.response_mapping),
        customParams: r.override_params ? this.parseJson(r.custom_params) : {},
        // 判断模型类型
        type: this.detectType(r.endpoint_path, r.supported_types),
      };
    } catch (e) {
      console.error('读取模型配置失败:', e);
      return null;
    }
  }

  /**
   * 根据模型特征自动判断配置
   */
  getAutoConfig(modelId) {
    const modelLower = modelId.toLowerCase();

    // 视频生成模型
    if (modelLower.includes('i2v') || modelLower.includes('t2v') ||
        modelLower.includes('svd') || modelLower.includes('luma')) {
      return {
        modelId,
        endpoint: '/services/aigc/video-generation/video-synthesis',
        method: 'POST',
        headers: { 'X-DashScope-Async': 'enable' },
        type: 'video',
        responseMapping: { task_id: 'output.task_id', status: 'output.task_status' },
      };
    }

    // 图片生成模型
    if (modelLower.includes('image') || modelLower.includes('wanx') ||
        modelLower.includes('sd') || modelLower.includes('dall') ||
        modelLower.includes('t2i') || modelLower.includes('i2i')) {
      return {
        modelId,
        endpoint: '/services/aigc/multimodal-generation/generation',
        method: 'POST',
        headers: {},
        type: 'image',
        responseMapping: { task_id: 'output.task_id', status: 'output.task_status' },
      };
    }

    // 文本聊天模型（默认）
    return {
      modelId,
      endpoint: '/v1/chat/completions',
      method: 'POST',
      headers: {},
      type: 'chat',
      responseMapping: {}, // 聊天是同步的，不需要 task_id
    };
  }

  /**
   * 判断模型类型
   */
  detectType(endpoint, supportedTypes) {
    if (endpoint.includes('video-generation')) return 'video';
    if (endpoint.includes('multimodal-generation')) return 'image';
    if (supportedTypes) {
      const types = this.parseJson(supportedTypes);
      if (types.includes('chat') || types.includes('completion')) return 'chat';
    }
    return 'chat'; // 默认
  }

  /**
   * 构建请求体 - 根据类型分发
   */
  buildRequestBody(model, params, config) {
    switch (config.type) {
      case 'video':
        return this.buildVideoRequest(model, params, config);
      case 'image':
        return this.buildImageRequest(model, params, config);
      case 'chat':
        return this.buildChatRequest(model, params, config);
      default:
        throw new Error(`未知的模型类型: ${config.type}`);
    }
  }

  /**
   * 视频生成请求体
   */
  buildVideoRequest(model, params, config) {
    const { prompt, images, audio, resolution = '720P', duration = 5 } = params;

    const media = [];

    // 添加图片（first_frame, last_frame）
    if (images && images.length > 0) {
      images.forEach((url, index) => {
        media.push({
          type: index === 0 ? 'first_frame' : (index === images.length - 1 ? 'last_frame' : 'reference_frame'),
          url,
        });
      });
    }

    // 添加音频（driving_audio）
    if (audio) {
      media.push({
        type: 'driving_audio',
        url: audio,
      });
    }

    return {
      model,
      input: {
        prompt: prompt || '',
        ...(media.length > 0 ? { media } : {}),
      },
      parameters: {
        resolution,
        duration: parseInt(duration) || 5,
        prompt_extend: params.prompt_extend !== false,
        watermark: params.watermark || false,
        ...config.customParams,
      },
    };
  }

  /**
   * 图片生成请求体
   */
  buildImageRequest(model, params, config) {
    const { prompt, images, aspect = '1:1', n = 1 } = params;

    const content = [];

    // 添加图片（图生图）
    if (images && images.length > 0) {
      for (const url of images) {
        content.push({ image: url });
      }
    }

    // 添加文本 prompt
    content.push({ text: prompt });

    return {
      model,
      input: {
        messages: [{
          role: 'user',
          content,
        }],
      },
      parameters: {
        size: this.mapAspectToSize(aspect),
        n: Math.min(Math.max(parseInt(n) || 1, 1), 4),
        watermark: params.watermark || false,
        thinking_mode: params.thinking_mode !== false,
        ...config.customParams,
      },
    };
  }

  /**
   * 文本聊天请求体
   */
  buildChatRequest(model, params, config) {
    const { messages, temperature = 0.7, max_tokens = 2048, stream = false } = params;

    return {
      model,
      messages: messages || [],
      temperature,
      max_tokens,
      stream,
      ...config.customParams,
    };
  }

  /**
   * 解析响应 - 根据类型分发
   */
  parseResponse(data, config) {
    switch (config.type) {
      case 'video':
      case 'image':
        return this.parseGenerationResponse(data, config);
      case 'chat':
        return this.parseChatResponse(data, config);
      default:
        return data;
    }
  }

  /**
   * 生成类响应解析（图片/视频）
   */
  parseGenerationResponse(data, config) {
    const mapping = config.responseMapping || {};

    return {
      type: config.type,
      taskId: this.getNestedValue(data, mapping.task_id) || data.output?.task_id || data.request_id || data.id,
      status: this.getNestedValue(data, mapping.status) || data.output?.task_status || 'PENDING',
      results: this.getNestedValue(data, mapping.results) || data.output?.results || data.output?.image_urls || data.output?.video_url || [],
      raw: data,
    };
  }

  /**
   * 聊天响应解析
   */
  parseChatResponse(data, config) {
    return {
      type: 'chat',
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage || {},
      raw: data,
    };
  }

  /**
   * 查询任务状态 - 构建查询 URL 和解析
   */
  buildQueryUrl(taskId, model, config) {
    // 不同接口有不同的查询方式
    if (config.type === 'video') {
      // 视频使用 task 查询接口
      return {
        url: `/tasks/${taskId}`,
        method: 'GET',
      };
    }

    // 图片也使用 task 查询
    return {
      url: `/tasks/${taskId}`,
      method: 'GET',
    };
  }

  /**
   * 工具方法
   */
  mapAspectToSize(aspect) {
    const map = {
      '1:1': '1024*1024',
      '16:9': '1280*720',
      '9:16': '720*1280',
      '4:3': '1024*768',
      '3:4': '768*1024',
      '2K': '2048*2048',
    };
    return map[aspect] || '1024*1024';
  }

  parseJson(v) {
    if (!v) return {};
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }

  getNestedValue(obj, path) {
    if (!path) return undefined;
    const keys = path.split('.');
    let value = obj;
    for (const key of keys) {
      if (value === null || value === undefined) return undefined;
      value = value[key];
    }
    return value;
  }

  clearCache() {
    this.configCache.clear();
  }
}

module.exports = new ModelConfigManager();
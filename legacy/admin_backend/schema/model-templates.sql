-- 模型 API 模板表
CREATE TABLE IF NOT EXISTS model_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_key VARCHAR(50) UNIQUE NOT NULL COMMENT '模板标识，如 wanx_image, wanx_video',
  name VARCHAR(100) NOT NULL COMMENT '模板名称',
  description TEXT COMMENT '模板说明',

  -- 支持的模型类型
  supported_types JSON NOT NULL COMMENT '支持的类型: ["t2i","i2i","t2v","i2v","chat","tts","stt"]',

  -- 请求配置
  endpoint_path VARCHAR(255) NOT NULL COMMENT 'API 路径，如 /services/aigc/video-generation/video-synthesis',
  http_method VARCHAR(10) DEFAULT 'POST' COMMENT 'HTTP 方法',
  headers JSON COMMENT '固定 headers，如 {"X-DashScope-Async": "enable"}',

  -- 请求体构造模板
  request_body_template TEXT COMMENT '请求体 JSON 模板，使用占位符语法',

  -- 响应解析配置
  response_mapping JSON COMMENT '响应字段映射，如 {"task_id": "output.task_id", "status": "output.task_status"}',

  -- 状态
  status TINYINT DEFAULT 1 COMMENT '1=启用, 0=禁用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模型 API 调用模板';

-- 模型-渠道详细配置表
CREATE TABLE IF NOT EXISTS model_channel_configs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  model_id VARCHAR(100) NOT NULL COMMENT '模型ID，对应 model_library.model_id',
  channel_id INT NOT NULL COMMENT '渠道ID，对应 proxy_channels.id',

  -- 模板配置
  template_id INT COMMENT '使用的模板ID，关联 model_templates.id',

  -- 覆盖配置
  override_endpoint BOOLEAN DEFAULT FALSE COMMENT '是否覆盖默认 endpoint',
  custom_endpoint_path VARCHAR(255) COMMENT '自定义 endpoint 路径',

  override_headers BOOLEAN DEFAULT FALSE COMMENT '是否覆盖默认 headers',
  custom_headers JSON COMMENT '自定义 headers',

  override_params BOOLEAN DEFAULT FALSE COMMENT '是否覆盖默认参数',
  custom_params JSON COMMENT '自定义默认参数',

  -- 优先级和权重
  priority INT DEFAULT 1 COMMENT '优先级，数字越小优先级越高',
  weight INT DEFAULT 100 COMMENT '权重，用于负载均衡（暂未使用）',

  -- 状态
  status TINYINT DEFAULT 1 COMMENT '1=启用, 0=禁用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_model_channel (model_id, channel_id),
  KEY idx_model_status (model_id, status),
  KEY idx_channel_status (channel_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模型在各渠道的详细配置';

-- 初始化默认模板数据

-- 万相图片生成模板
INSERT INTO model_templates (template_key, name, description, supported_types, endpoint_path, http_method, headers, request_body_template, response_mapping) VALUES
('wanx_image', '万相图片生成', '阿里云万相图片生成 API', '["t2i", "i2i"]', '/services/aigc/multimodal-generation/generation', 'POST', NULL, '{
  "model": "${model}",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [
          ${if:images}
          ${foreach:images as img}
          { "image": "${img}" }${sep},
          ${endforeach}
          ${endif}
          { "text": "${prompt}" }
        ]
      }
    ]
  },
  "parameters": {
    "size": "${params.size || '2K'}",
    "n": ${params.n || 1},
    "watermark": ${params.watermark || false},
    "thinking_mode": ${params.thinking_mode || true}
  }
}', '{"task_id": "output.task_id", "status": "output.task_status", "result": "output.results"}')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  supported_types = VALUES(supported_types),
  endpoint_path = VALUES(endpoint_path),
  request_body_template = VALUES(request_body_template),
  response_mapping = VALUES(response_mapping);

-- 万相视频生成模板
INSERT INTO model_templates (template_key, name, description, supported_types, endpoint_path, http_method, headers, request_body_template, response_mapping) VALUES
('wanx_video', '万相视频生成', '阿里云万相视频生成 API', '["t2v", "i2v"]', '/services/aigc/video-generation/video-synthesis', 'POST', '{"X-DashScope-Async": "enable"}', '{
  "model": "${model}",
  "input": {
    "prompt": "${prompt}",
    ${if:images}
    "media": [
      ${foreach:images as img}
      { "type": "${img.type || (loop.index0 == 0 ? 'first_frame' : 'last_frame')}", "url": "${img.url || img}" }${sep}
      ${endforeach}
    ],
    ${endif}
    ${if:audio}
    "media": [
      { "type": "driving_audio", "url": "${audio}" }
    ],
    ${endif}
  },
  "parameters": {
    "resolution": "${params.resolution || '720P'}",
    "duration": ${params.duration || 5},
    "prompt_extend": ${params.prompt_extend || true},
    "watermark": ${params.watermark || false}
  }
}', '{"task_id": "output.task_id", "status": "output.task_status"}')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  supported_types = VALUES(supported_types),
  endpoint_path = VALUES(endpoint_path),
  headers = VALUES(headers),
  request_body_template = VALUES(request_body_template),
  response_mapping = VALUES(response_mapping);

-- OpenAI 兼容聊天模板
INSERT INTO model_templates (template_key, name, description, supported_types, endpoint_path, http_method, headers, request_body_template, response_mapping) VALUES
('openai_chat', 'OpenAI 兼容聊天', 'OpenAI API 兼容格式', '["chat", "completion"]', '/v1/chat/completions', 'POST', NULL, '{
  "model": "${model}",
  "messages": ${messages},
  "temperature": ${params.temperature || 0.7},
  "max_tokens": ${params.max_tokens || 2048},
  "stream": ${params.stream || false}
}', '{"content": "choices[0].message.content", "usage": "usage"}')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  supported_types = VALUES(supported_types),
  endpoint_path = VALUES(endpoint_path),
  request_body_template = VALUES(request_body_template),
  response_mapping = VALUES(response_mapping);
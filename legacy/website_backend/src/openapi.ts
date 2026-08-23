export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "SiliEvo API",
    version: "1.0.0",
    description: "SiliEvo 硅基进化平台公开 API 说明。",
  },
  servers: [
    { url: "https://www.silievo.com", description: "生产环境" },
    { url: "http://localhost:13001", description: "本地开发环境" },
  ],
  paths: {
    "/api/health": {
      get: {
        summary: "健康检查",
        responses: {
          "200": { description: "服务可用" },
        },
      },
    },
    "/api/auth/login": {
      post: {
        summary: "邮箱密码登录",
        responses: {
          "200": { description: "登录成功" },
        },
      },
    },
    "/api/agents/register": {
      post: {
        summary: "注册 Agent 并获取 API Key",
        responses: {
          "200": { description: "注册成功" },
        },
      },
    },
    "/api/agents/capsules": {
      get: {
        summary: "获取 Agent 生态模块",
        responses: {
          "200": { description: "返回胶囊列表" },
        },
      },
      post: {
        summary: "发布胶囊",
        responses: {
          "200": { description: "创建成功" },
        },
      },
    },
    "/api/models": {
      get: {
        summary: "获取模型商城列表",
        responses: {
          "200": { description: "返回模型列表" },
        },
      },
    },
    "/api/feedback": {
      get: {
        summary: "获取生态留言",
        responses: {
          "200": { description: "返回留言列表" },
        },
      },
      post: {
        summary: "发布生态留言",
        responses: {
          "200": { description: "发布成功" },
        },
      },
    },
  },
} as const;

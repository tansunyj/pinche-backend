/**
 * MediaProvider 注册表
 *
 * 新增厂商步骤：
 *   1. 写 XxxProvider.ts，实现 MediaProvider 接口
 *   2. 在下方 PROVIDERS 数组添加一行
 *   3. 在 marketplace 模型表里 INSERT 一条记录（provider 字段填 name）
 *
 * 不要在业务代码里直接 import 具体 Provider，统一走 getProvider(name)
 */

import type { MediaProvider, MediaKind } from "./MediaProvider";
import mockProvider from "./MockProvider";
import wanxProvider from "./WanxProvider";
import videoProvider from "./VideoProvider";
import volcengineProvider from "./VolcVideoProvider";

/** dry-run 模式：所有任务强制走 MockProvider，忽略模型实际 provider */
export function isDryRun(): boolean {
  return process.env.MEDIA_DRY_RUN === "true" || process.env.MEDIA_DRY_RUN === "1";
}

/** 已注册的 Provider（按 name 唯一） */
const PROVIDERS: MediaProvider[] = [
  mockProvider,
  wanxProvider,         // 通义万相（name="alibaba"）
  videoProvider,        // 通义万相视频（name="alibaba-video"）
  volcengineProvider,   // 火山引擎 Seedance（name="volcengine"）
  // klingProvider,    // 阶段 E 接入
];

const REGISTRY = new Map<string, MediaProvider>(PROVIDERS.map((p) => [p.name, p]));

/**
 * 根据 provider_name 取 Provider 实例。
 * dry-run 模式下不论传什么都返回 MockProvider。
 */
export function getProvider(providerName: string): MediaProvider {
  console.log(`[MediaProvider:DEBUG] getProvider called, name=${providerName}, dryRun=${isDryRun()}, registered=[${[...REGISTRY.keys()].join(", ")}]`);

  if (isDryRun()) {
    console.log(`[MediaProvider:DEBUG] dry-run 模式，返回 mock`);
    return mockProvider;
  }

  const p = REGISTRY.get(providerName);
  if (!p) {
    throw new Error(
      `未知的媒体厂商: ${providerName}（已注册：${[...REGISTRY.keys()].join(", ")}）`
    );
  }
  console.log(`[MediaProvider:DEBUG] 返回 provider: ${p.name}, supports=[${p.supports.join(",")}], configured=${p.isConfigured()}`);
  return p;
}

/** 列出所有"已配置"的 Provider（前端模型卡片置灰用） */
export function listConfiguredProviders(): MediaProvider[] {
  return PROVIDERS.filter((p) => p.isConfigured());
}

/** 列出所有 Provider 元信息（用于 /api/media/providers 调试接口） */
export function describeProviders(): Array<{
  name: string;
  configured: boolean;
  supports: ReadonlyArray<MediaKind>;
}> {
  return PROVIDERS.map((p) => ({
    name: p.name,
    configured: p.isConfigured(),
    supports: p.supports,
  }));
}

export { mockProvider };
export type { MediaProvider, MediaKind };

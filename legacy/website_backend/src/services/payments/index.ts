/**
 * 支付通道注册表
 *
 * 上游路由通过 getProvider(name) 获取实例；前端通过 listAvailable() 拿可用通道列表。
 */

import type { PaymentProvider, ProviderName } from "./PaymentProvider";
import { AlipayProvider } from "./AlipayProvider";
import { WechatPayProvider } from "./WechatPayProvider";

const providers: Record<string, PaymentProvider> = {
  alipay: new AlipayProvider(),
  wechat: new WechatPayProvider(),
  // 后续：stripe / paypal
};

export function getProvider(name: ProviderName | string): PaymentProvider | null {
  return providers[name] || null;
}

export function listAvailableProviders(): Array<{
  name: ProviderName;
  configured: boolean;
  dryRun: boolean;
}> {
  return Object.values(providers).map((p) => ({
    name: p.name,
    configured: p.isConfigured(),
    dryRun: p.isDryRun(),
  }));
}

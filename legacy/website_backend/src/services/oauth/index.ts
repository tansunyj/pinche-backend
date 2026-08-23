import type { OAuthProvider, OAuthProviderName } from "./OAuthProvider";
import { WechatOAuthProvider } from "./WechatOAuthProvider";
import { AlipayOAuthProvider } from "./AlipayOAuthProvider";

const providers: Record<OAuthProviderName, OAuthProvider> = {
  wechat: new WechatOAuthProvider(),
  alipay: new AlipayOAuthProvider(),
};

export function getOAuthProvider(name: string): OAuthProvider | null {
  return (providers as any)[name] || null;
}

export function listOAuthProviders(): Array<{
  name: OAuthProviderName;
  configured: boolean;
  dryRun: boolean;
}> {
  return Object.values(providers).map((p) => ({
    name: p.name,
    configured: p.isConfigured(),
    dryRun: p.isDryRun(),
  }));
}

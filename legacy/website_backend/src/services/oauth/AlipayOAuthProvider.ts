/**
 * 支付宝开放平台 OAuth2 扫码登录（auth_user 模式）
 *
 * 文档：https://opendocs.alipay.com/open/200/105337
 * 授权 URL: https://openauth.alipay.com/oauth2/publicAppAuthorize.htm?app_id=&scope=auth_user&redirect_uri=&state=
 *
 * 当前实现：DRY-RUN stub。
 */

import {
  OAuthProvider,
  OAuthAuthUrlResult,
  OAuthUserInfo,
  isOAuthDryRun,
} from "./OAuthProvider";

export class AlipayOAuthProvider implements OAuthProvider {
  readonly name = "alipay" as const;

  isConfigured(): boolean {
    return !!(
      process.env.ALIPAY_APP_ID &&
      (process.env.ALIPAY_APP_PRIVATE_KEY || process.env.ALIPAY_APP_PRIVATE_KEY_PATH) &&
      process.env.ALIPAY_PUBLIC_KEY &&
      process.env.ALIPAY_REDIRECT_URI
    );
  }

  isDryRun(): boolean {
    return isOAuthDryRun() || !this.isConfigured();
  }

  buildAuthUrl(state: string): OAuthAuthUrlResult {
    const appId = process.env.ALIPAY_APP_ID || "MOCK_APP_ID";
    const redirect = process.env.ALIPAY_REDIRECT_URI || "http://localhost:13001/api/oauth/alipay/callback";

    const url =
      `https://openauth.alipay.com/oauth2/publicAppAuthorize.htm?` +
      `app_id=${encodeURIComponent(appId)}` +
      `&scope=auth_user` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&state=${encodeURIComponent(state)}`;

    console.log(`[AlipayOAuth] buildAuthUrl state=${state} dryRun=${this.isDryRun()}`);
    return { qrCodeContent: url, authPageUrl: url };
  }

  async exchangeCode(code: string): Promise<OAuthUserInfo> {
    console.log(`\n========== [AlipayOAuth] exchangeCode ==========`);
    console.log(`[AlipayOAuth] code=${code} dryRun=${this.isDryRun()}`);

    if (this.isDryRun()) {
      const mockUserId = `mock_alipay_${Date.now()}`;
      console.log(`[AlipayOAuth] DRY-RUN → mock providerId=${mockUserId}`);
      return {
        providerId: mockUserId,
        nickname: "测试支付宝用户",
        avatar: "",
        realNameVerified: true,
        raw: { mock: true },
      };
    }

    // TODO(真实):
    // 1. alipay.system.oauth.token: grant_type=authorization_code&code=xxx → 拿 access_token + user_id
    // 2. alipay.user.info.share: 用 access_token → 拿 nickname/avatar/...
    // 签名 + 网关都走 ALIPAY_GATEWAY
    throw new Error("AlipayOAuth 真实接入尚未启用");
  }
}

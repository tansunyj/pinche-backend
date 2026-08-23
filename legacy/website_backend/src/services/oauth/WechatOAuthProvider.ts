/**
 * 微信开放平台"网站应用"OAuth2 扫码登录
 *
 * 文档：https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html
 * 扫码授权 URL: https://open.weixin.qq.com/connect/qrconnect?appid=APPID&redirect_uri=URL&response_type=code&scope=snsapi_login&state=STATE#wechat_redirect
 *
 * 当前实现：DRY-RUN stub。配齐 WECHAT_OPEN_APPID + APP_SECRET + REDIRECT_URI 后启用。
 */

import {
  OAuthProvider,
  OAuthAuthUrlResult,
  OAuthUserInfo,
  isOAuthDryRun,
} from "./OAuthProvider";

export class WechatOAuthProvider implements OAuthProvider {
  readonly name = "wechat" as const;

  isConfigured(): boolean {
    return !!(
      process.env.WECHAT_OPEN_APPID &&
      process.env.WECHAT_OPEN_APP_SECRET &&
      process.env.WECHAT_OPEN_REDIRECT_URI
    );
  }

  isDryRun(): boolean {
    return isOAuthDryRun() || !this.isConfigured();
  }

  buildAuthUrl(state: string): OAuthAuthUrlResult {
    const appid = process.env.WECHAT_OPEN_APPID || "MOCK_APPID";
    const redirect = process.env.WECHAT_OPEN_REDIRECT_URI || "http://localhost:13001/api/oauth/wechat/callback";

    const url =
      `https://open.weixin.qq.com/connect/qrconnect?` +
      `appid=${encodeURIComponent(appid)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&response_type=code&scope=snsapi_login` +
      `&state=${encodeURIComponent(state)}#wechat_redirect`;

    console.log(`[WechatOAuth] buildAuthUrl state=${state} dryRun=${this.isDryRun()}`);
    return { qrCodeContent: url, authPageUrl: url };
  }

  async exchangeCode(code: string): Promise<OAuthUserInfo> {
    console.log(`\n========== [WechatOAuth] exchangeCode ==========`);
    console.log(`[WechatOAuth] code=${code} dryRun=${this.isDryRun()}`);

    if (this.isDryRun()) {
      // mock 一个 openid，便于联调
      const mockOpenId = `mock_wx_${Date.now()}`;
      console.log(`[WechatOAuth] DRY-RUN → mock providerId=${mockOpenId}`);
      return {
        providerId: mockOpenId,
        nickname: "测试微信用户",
        avatar: "",
        raw: { mock: true },
      };
    }

    // TODO(真实): 两步走
    // 1. GET https://api.weixin.qq.com/sns/oauth2/access_token?appid=&secret=&code=&grant_type=authorization_code
    //    → { access_token, openid, unionid? }
    // 2. GET https://api.weixin.qq.com/sns/userinfo?access_token=&openid=&lang=zh_CN
    //    → { nickname, headimgurl, ... }
    // 优先用 unionid 作为 providerId（跨应用一致）
    throw new Error("WechatOAuth 真实接入尚未启用");
  }
}

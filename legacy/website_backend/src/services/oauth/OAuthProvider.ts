/**
 * 第三方扫码登录抽象
 *
 *   WechatOAuth: 微信开放平台"网站应用"OAuth2  (snsapi_login)
 *   AlipayOAuth: 支付宝开放平台 OAuth2 (auth_user)
 */

export type OAuthProviderName = "wechat" | "alipay";

export interface OAuthAuthUrlResult {
  /** 让用户扫描的 URL（通常本身就是登录授权页地址），前端用 qrcode 库渲染为二维码 */
  qrCodeContent: string;
  /** 给前端备用：直接打开新窗口让用户在该页面授权（非二维码模式） */
  authPageUrl: string;
}

export interface OAuthUserInfo {
  /** 第三方稳定 ID：微信 unionid 或 openid；支付宝 user_id */
  providerId: string;
  /** 昵称/真实姓名 */
  nickname?: string;
  /** 头像 URL */
  avatar?: string;
  /** 是否经手机号实名（支付宝） */
  realNameVerified?: boolean;
  /** 调试用原始返回 */
  raw?: Record<string, any>;
}

export interface OAuthProvider {
  readonly name: OAuthProviderName;
  isConfigured(): boolean;
  isDryRun(): boolean;

  /** 构造让用户扫码的 URL */
  buildAuthUrl(state: string): OAuthAuthUrlResult;

  /** 回调阶段：用 code 换 user info */
  exchangeCode(code: string): Promise<OAuthUserInfo>;
}

export function isOAuthDryRun(): boolean {
  return (process.env.OAUTH_DRY_RUN || "").toLowerCase() === "true";
}

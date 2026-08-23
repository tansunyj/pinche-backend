/**
 * 支付通道抽象接口
 *
 * 所有具体支付通道（Alipay / Wechat / Stripe / PayPal）都实现这个接口，
 * 上层 routes/payments.ts 只面向接口编程。
 */

import type { BillingOrder, PayMethod } from "../BillingService";

export type ProviderName = PayMethod;

export interface CreatePaymentResult {
  /** 用户扫码支付的二维码内容（原始 URL 或 code_url）；前端可用 qrcode 库渲染 */
  qrCodeContent?: string;
  /** PC 端跳转支付的 URL（如 alipay PC 网关页） */
  payPageUrl?: string;
  /** 微信 H5 / 移动端跳转 URL */
  h5Url?: string;
  /** 第三方分配的预下单/交易号（落库便于追溯） */
  providerPrepayId?: string;
  /** 额外原始返回（日志/排错用） */
  raw?: Record<string, any>;
}

export interface VerifiedNotify {
  /** 我们的业务订单号 */
  orderNo: string;
  /** 第三方流水号（支付宝 trade_no / 微信 transaction_id） */
  thirdPartyNo: string;
  /** 第三方确认的实付金额（元，校验防篡改） */
  amount: number;
  /** 第三方端的支付时间 */
  paidAt?: Date;
  /** 是否成功；某些回调会发"关闭/退款/取消"事件 */
  status: "paid" | "failed" | "refunded" | "cancelled" | "other";
}

export interface PaymentProvider {
  readonly name: ProviderName;
  /** 配置是否齐全（齐全才会被注册到路由；不齐全则前端按钮 disable） */
  isConfigured(): boolean;
  /** 当前是否走 dry-run（mock）模式 */
  isDryRun(): boolean;

  /**
   * 创建支付：根据订单生成第三方支付入口（二维码 / 跳转 URL）
   */
  createPayment(order: BillingOrder): Promise<CreatePaymentResult>;

  /**
   * 异步回调验签：解析 + 校验 + 返回业务关心字段
   * @throws 验签失败 / 解析失败 / 防重放命中
   */
  verifyNotify(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>
  ): Promise<VerifiedNotify>;

  /**
   * 主动查单（用户长时间没收到异步通知时兜底）
   */
  queryOrder(order: BillingOrder): Promise<{
    status: VerifiedNotify["status"];
    thirdPartyNo?: string;
    paidAt?: Date;
  }>;
}

/** dry-run 通用工具 */
export function isPaymentDryRun(): boolean {
  return (process.env.PAYMENT_DRY_RUN || "").toLowerCase() === "true";
}

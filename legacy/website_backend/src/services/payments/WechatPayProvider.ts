/**
 * 微信支付通道（V3 API · Native 扫码支付）
 *
 * 当前实现：DRY-RUN stub。备案 + 商户接入完成后：
 *   1. npm i wechatpay-node-v3 （或自行实现 V3 签名 / AES-GCM 解密）
 *   2. 把下面三处 TODO 替换为真实调用
 *
 * 真实接入参考：
 *   - 下单：POST /v3/pay/transactions/native，body 含 mchid/appid/notify_url/out_trade_no/amount...
 *   - 回调：解析 ciphertext + AEAD_AES_256_GCM（用 WECHAT_PAY_API_V3_KEY 解密）
 *   - 文档：https://pay.weixin.qq.com/doc/v3/merchant/4012791897
 */

import crypto from "crypto";
import {
  PaymentProvider,
  CreatePaymentResult,
  VerifiedNotify,
  isPaymentDryRun,
} from "./PaymentProvider";
import type { BillingOrder } from "../BillingService";

export class WechatPayProvider implements PaymentProvider {
  readonly name = "wechat" as const;

  isConfigured(): boolean {
    return !!(
      process.env.WECHAT_PAY_APPID &&
      process.env.WECHAT_PAY_MCH_ID &&
      process.env.WECHAT_PAY_API_V3_KEY &&
      process.env.WECHAT_PAY_CERT_SERIAL &&
      (process.env.WECHAT_PAY_PRIVATE_KEY || process.env.WECHAT_PAY_PRIVATE_KEY_PATH)
    );
  }

  isDryRun(): boolean {
    return isPaymentDryRun() || !this.isConfigured();
  }

  async createPayment(order: BillingOrder): Promise<CreatePaymentResult> {
    console.log(`\n========== [WechatPay] createPayment ==========`);
    console.log(`[WechatPay] order_no=${order.order_no} amount=¥${order.amount} dryRun=${this.isDryRun()}`);

    if (this.isDryRun()) {
      // 微信 Native 下单返回 code_url（weixin://wxpay/bizpayurl?pr=xxx），mock 一个
      const mockCodeUrl = `weixin://wxpay/bizpayurl?pr=mock_${order.order_no}`;
      console.log(`[WechatPay] DRY-RUN → 返回 mock code_url: ${mockCodeUrl}`);
      return {
        qrCodeContent: mockCodeUrl,
        providerPrepayId: `MOCK_WX_${order.order_no}`,
        raw: { mock: true },
      };
    }

    // TODO(SDK): 真实接入
    // const body = {
    //   appid: process.env.WECHAT_PAY_APPID,
    //   mchid: process.env.WECHAT_PAY_MCH_ID,
    //   description: `SiliEvo 充值 ¥${order.amount}`,
    //   out_trade_no: order.order_no,
    //   notify_url: process.env.WECHAT_PAY_NOTIFY_URL || `${process.env.PAYMENT_NOTIFY_BASE_URL}/api/payments/notify/wechat`,
    //   amount: { total: Math.round(Number(order.amount) * 100), currency: "CNY" },
    // };
    // const sig = signV3("POST", "/v3/pay/transactions/native", JSON.stringify(body), loadPrivateKey());
    // const res = await fetch("https://api.mch.weixin.qq.com/v3/pay/transactions/native", { ... });
    // return { qrCodeContent: res.code_url };
    throw new Error("WechatPay 真实接入尚未启用");
  }

  async verifyNotify(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>
  ): Promise<VerifiedNotify> {
    console.log(`\n========== [WechatPay] verifyNotify ==========`);
    // 确保 bodyStr 是字符串
    let bodyStr: string;
    if (Buffer.isBuffer(rawBody)) {
      bodyStr = rawBody.toString("utf8");
    } else if (typeof rawBody === "string") {
      bodyStr = rawBody;
    } else {
      // 处理其他情况（如 undefined 或对象）
      bodyStr = String(rawBody || "");
    }
    console.log(`[WechatPay] raw body (前200): ${bodyStr.slice(0, 200)}`);

    if (this.isDryRun()) {
      // dry-run：约定回调直接传 JSON {orderNo, thirdPartyNo, amount}（dev 工具触发）
      let json: any = {};
      try { json = JSON.parse(bodyStr); } catch { /* noop */ }
      console.log(`[WechatPay] DRY-RUN → 跳过 AEAD 解密 + 签名`);
      return {
        orderNo: json.orderNo || json.out_trade_no || "",
        thirdPartyNo: json.thPartyNo || json.transaction_id || `MOCK_WX_TID_${Date.now()}`,
        amount: Number(json.amount || 0),
        paidAt: new Date(),
        status: "paid",
      };
    }

    // TODO(SDK): 真实接入
    // 1. 校验 headers 里 Wechatpay-Signature, Wechatpay-Timestamp, Wechatpay-Nonce, Wechatpay-Serial
    // 2. 用平台证书公钥验签 拼接串 = timestamp + "\n" + nonce + "\n" + body + "\n"
    // 3. 解密 resource.ciphertext（AES-256-GCM, key=API_V3_KEY, iv=resource.nonce, aad=resource.associated_data）
    // 4. 校验解密后的 out_trade_no / mchid / amount.payer_total
    throw new Error("WechatPay verifyNotify 真实接入尚未启用");
  }

  async queryOrder(order: BillingOrder): Promise<{
    status: VerifiedNotify["status"];
    thirdPartyNo?: string;
    paidAt?: Date;
  }> {
    console.log(`[WechatPay] queryOrder order_no=${order.order_no} dryRun=${this.isDryRun()}`);
    if (this.isDryRun()) {
      return { status: "other" };
    }
    // TODO(SDK): GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=xxx
    throw new Error("WechatPay queryOrder 真实接入尚未启用");
  }
}

function _loadWechatPayPrivateKey(): string {
  const inline = process.env.WECHAT_PAY_PRIVATE_KEY;
  if (inline) return inline.includes("BEGIN") ? inline : `-----BEGIN PRIVATE KEY-----\n${inline}\n-----END PRIVATE KEY-----\n`;
  const path = process.env.WECHAT_PAY_PRIVATE_KEY_PATH;
  if (path) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("fs").readFileSync(path, "utf8");
  }
  throw new Error("WECHAT_PAY_PRIVATE_KEY 与 _PATH 都未配置");
}

void crypto;
void _loadWechatPayPrivateKey;

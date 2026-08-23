/**
 * 支付宝通道（PC 扫码 / 当面付）—— 移植自老 website_backend AlipayProvider.ts
 * 使用原生 crypto RSA2 签名，无第三方 SDK 依赖。
 * DRY_RUN（PAYMENT_DRY_RUN=true 或未配置密钥）时返回 mock 二维码，便于本地联调。
 */

import crypto from "crypto";

export interface CreatePaymentResult {
  qrCodeContent: string;
  providerPrepayId: string;
  raw: any;
}

export interface VerifiedNotify {
  orderNo: string;
  thirdPartyNo: string;
  amount: number;
  paidAt: Date;
  status: "paid" | "other";
}

const GATEWAY = process.env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do";

export class AlipayProvider {
  readonly name = "alipay" as const;

  isConfigured(): boolean {
    return !!(
      process.env.ALIPAY_APP_ID &&
      process.env.ALIPAY_APP_PRIVATE_KEY &&
      process.env.ALIPAY_PUBLIC_KEY
    );
  }

  isDryRun(): boolean {
    return process.env.PAYMENT_DRY_RUN === "true" || !this.isConfigured();
  }

  /** 生成 PC 扫码支付订单，返回二维码内容 */
  async createPayment(input: {
    orderNo: string;
    amountYuan: number;
    subject: string;
  }): Promise<CreatePaymentResult> {
    if (this.isDryRun()) {
      const mockQr = `https://qr.alipay.com/bax_mock_${input.orderNo}`;
      console.log(`[Alipay] DRY-RUN → mock qrCode: ${mockQr}`);
      return { qrCodeContent: mockQr, providerPrepayId: `MOCK_PREPAY_${input.orderNo}`, raw: { mock: true } };
    }

    const notifyUrl =
      process.env.ALIPAY_NOTIFY_URL ||
      `${process.env.PAYMENT_NOTIFY_BASE_URL || ""}/api/recharge/callback`;

    const params: Record<string, string> = {
      app_id: process.env.ALIPAY_APP_ID!,
      method: "alipay.trade.precreate",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: formatDate(new Date()),
      version: "1.0",
      notify_url: notifyUrl,
      biz_content: JSON.stringify({
        out_trade_no: input.orderNo,
        total_amount: Number(input.amountYuan).toFixed(2),
        subject: input.subject,
        timeout_express: "15m", // 15 分钟未支付自动关闭
      }),
    };
    params.sign = this._signRsa2(params);

    const response = await fetch(GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(),
    });
    const rawText = await response.text();
    const result = JSON.parse(rawText);
    const alipayResp = result.alipay_trade_precreate_response;
    if (!alipayResp || alipayResp.code !== "10000") {
      throw new Error(`支付宝下单失败: ${alipayResp?.msg || "未知"} (${alipayResp?.sub_msg || ""})`);
    }
    return { qrCodeContent: alipayResp.qr_code, providerPrepayId: alipayResp.out_trade_no, raw: result };
  }

  /** 校验支付宝回调（RSA2 验签 + app_id 比对） */
  async verifyNotify(bodyStr: string): Promise<VerifiedNotify> {
    if (this.isDryRun()) {
      const params = new URLSearchParams(bodyStr);
      const orderNo = params.get("out_trade_no") || "";
      const tradeStatus = params.get("trade_status") || "TRADE_SUCCESS";
      console.log(`[Alipay] DRY-RUN → 跳过验签，trade_status=${tradeStatus}`);
      return {
        orderNo,
        thirdPartyNo: params.get("trade_no") || `MOCK_TRADE_${orderNo}`,
        amount: Number(params.get("total_amount") || "0"),
        paidAt: new Date(),
        status: tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED" ? "paid" : "other",
      };
    }

    const params = new URLSearchParams(bodyStr);
    const data: Record<string, string> = {};
    for (const [key, value] of params) data[key] = value;

    const sign = data.sign;
    if (!sign) throw new Error("支付宝回调缺少 sign 参数");
    delete data.sign;
    delete data.sign_type;

    const verified = this._verifyRsa2(this._buildSignContent(data), sign, this._loadAlipayPublicKey());
    if (!verified) throw new Error("支付宝回调验签失败");
    if (data.app_id !== process.env.ALIPAY_APP_ID) throw new Error(`app_id 不匹配`);

    const tradeStatus = data.trade_status;
    return {
      orderNo: data.out_trade_no,
      thirdPartyNo: data.trade_no,
      amount: Number(data.total_amount || data.buyer_pay_amount || "0"),
      paidAt: new Date(),
      status: tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED" ? "paid" : "other",
    };
  }

  /** 查询订单状态（对账/补漏单用） */
  async queryOrder(orderNo: string): Promise<{ status: "paid" | "other"; thirdPartyNo?: string }> {
    if (this.isDryRun()) return { status: "other" };
    const params: Record<string, string> = {
      app_id: process.env.ALIPAY_APP_ID!,
      method: "alipay.trade.query",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: formatDate(new Date()),
      version: "1.0",
      biz_content: JSON.stringify({ out_trade_no: orderNo }),
    };
    params.sign = this._signRsa2(params);

    const response = await fetch(GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(),
    });
    const result = (await response.json()) as any;
    const alipayResp = result.alipay_trade_query_response;
    if (!alipayResp || alipayResp.code !== "10000") return { status: "other" };
    const tradeStatus = alipayResp.trade_status;
    return {
      status: tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED" ? "paid" : "other",
      thirdPartyNo: alipayResp.trade_no,
    };
  }

  // ============ RSA2 签名工具 ============

  private _signRsa2(params: Record<string, string>): string {
    const content = this._buildSignContent(params);
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(content, "utf8");
    return sign.sign(this._loadPrivateKey(), "base64");
  }

  private _verifyRsa2(content: string, sign: string, publicKey: string): boolean {
    try {
      const verify = crypto.createVerify("RSA-SHA256");
      verify.update(content, "utf8");
      return verify.verify(publicKey, sign, "base64");
    } catch (e) {
      console.error("[Alipay] 验签错误:", e);
      return false;
    }
  }

  private _buildSignContent(params: Record<string, string>): string {
    return Object.keys(params)
      .filter((k) => params[k] !== "" && params[k] !== undefined)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
  }

  private _loadPrivateKey(): string {
    const inline = process.env.ALIPAY_APP_PRIVATE_KEY;
    if (!inline) throw new Error("ALIPAY_APP_PRIVATE_KEY 未配置");
    return this._wrapPem(inline, "RSA PRIVATE KEY");
  }

  private _loadAlipayPublicKey(): string {
    const inline = process.env.ALIPAY_PUBLIC_KEY;
    if (!inline) throw new Error("ALIPAY_PUBLIC_KEY 未配置");
    return this._wrapPem(inline, "PUBLIC KEY");
  }

  private _wrapPem(b64: string, type: string): string {
    if (b64.includes("BEGIN")) return b64;
    const lines = b64.match(/.{1,64}/g) || [];
    return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
  }
}

export default new AlipayProvider();

function formatDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

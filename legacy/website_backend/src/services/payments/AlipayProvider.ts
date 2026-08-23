/**
 * 支付宝支付通道（PC 当面付 / 扫码支付）
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { URLSearchParams } from "url";
import {
  PaymentProvider,
  CreatePaymentResult,
  VerifiedNotify,
  isPaymentDryRun,
} from "./PaymentProvider";
import type { BillingOrder } from "../BillingService";

export class AlipayProvider implements PaymentProvider {
  readonly name = "alipay" as const;

  isConfigured(): boolean {
    return !!(
      process.env.ALIPAY_APP_ID &&
      (process.env.ALIPAY_APP_PRIVATE_KEY || process.env.ALIPAY_APP_PRIVATE_KEY_PATH) &&
      process.env.ALIPAY_PUBLIC_KEY
    );
  }

  isDryRun(): boolean {
    return isPaymentDryRun() || !this.isConfigured();
  }

  async createPayment(order: BillingOrder): Promise<CreatePaymentResult> {
    console.log(`\n========== [Alipay] createPayment ==========`);
    console.log(`[Alipay] order_no=${order.order_no} amount=¥${order.amount} dryRun=${this.isDryRun()}`);

    if (this.isDryRun()) {
      const mockQr = `https://qr.alipay.com/bax_mock_${order.order_no}`;
      console.log(`[Alipay] DRY-RUN → 返回 mock qrCode: ${mockQr}`);
      return {
        qrCodeContent: mockQr,
        providerPrepayId: `MOCK_PREPAY_${order.order_no}`,
        raw: { mock: true },
      };
    }

    // 真实接入
    const baseUrl = process.env.PAYMENT_NOTIFY_BASE_URL || "";
    const notifyUrl = process.env.ALIPAY_NOTIFY_URL || `${baseUrl}/api/payments/notify/alipay`;

    const timestamp = formatDate(new Date(), "YYYY-MM-DD HH:mm:ss");
    const bizContent = JSON.stringify({
      out_trade_no: order.order_no,
      total_amount: Number(order.amount).toFixed(2),
      subject: `硅基进化充值 ¥${order.amount}`,
      body: `充值${order.points}硅币`,
    });

    const params: Record<string, string> = {
      app_id: process.env.ALIPAY_APP_ID!,
      method: "alipay.trade.precreate",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp,
      version: "1.0",
      notify_url: notifyUrl,
      biz_content: bizContent,
    };

    const sign = this._signRsa2(params);
    params.sign = sign;

    console.log(`[Alipay] 发送请求 gateway=${process.env.ALIPAY_GATEWAY}`);

    const gateway = process.env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do";
    const response = await fetch(gateway, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(),
    });

    const rawText = await response.text();
    console.log(`[Alipay] 原始响应: ${rawText.slice(0, 500)}`);

    let result: any;
    try {
      result = JSON.parse(rawText);
    } catch {
      throw new Error(`支付宝响应解析失败: ${rawText.slice(0, 200)}`);
    }

    const alipayResp = result.alipay_trade_precreate_response;
    if (!alipayResp) {
      throw new Error(`支付宝响应格式错误: ${rawText.slice(0, 200)}`);
    }

    if (alipayResp.code !== "10000") {
      throw new Error(`支付宝下单失败: ${alipayResp.msg} (${alipayResp.sub_code}: ${alipayResp.sub_msg})`);
    }

    console.log(`[Alipay] 下单成功, qr_code: ${alipayResp.qr_code}`);

    return {
      qrCodeContent: alipayResp.qr_code,
      providerPrepayId: alipayResp.out_trade_no,
      raw: result,
    };
  }

  async verifyNotify(rawBody: string | Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifiedNotify> {
    console.log(`\n========== [Alipay] verifyNotify ==========`);
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    console.log(`[Alipay] raw body (前500): ${bodyStr.slice(0, 500)}`);

    if (this.isDryRun()) {
      const params = new URLSearchParams(bodyStr);
      const orderNo = params.get("out_trade_no") || "";
      const thirdPartyNo = params.get("trade_no") || `MOCK_TRADE_${orderNo}`;
      const amount = Number(params.get("total_amount") || "0");
      const tradeStatus = params.get("trade_status") || "TRADE_SUCCESS";
      console.log(`[Alipay] DRY-RUN → 跳过验签，trade_status=${tradeStatus}`);
      return {
        orderNo,
        thirdPartyNo,
        amount,
        paidAt: new Date(),
        status: tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED" ? "paid" : "other",
      };
    }

    const params = new URLSearchParams(bodyStr);
    const data: Record<string, string> = {};
    for (const [key, value] of params) {
      data[key] = value;
    }

    const sign = data.sign;
    if (!sign) {
      throw new Error("支付宝回调缺少 sign 参数");
    }

    delete data.sign;
    delete data.sign_type;

    const verifyContent = this._buildSignContent(data);
    console.log(`[Alipay] 验签内容: ${verifyContent.slice(0, 200)}...`);

    const publicKey = this._loadAlipayPublicKey();
    const verified = this._verifyRsa2(verifyContent, sign, publicKey);

    if (!verified) {
      throw new Error("支付宝回调验签失败");
    }

    console.log(`[Alipay] 验签成功`);

    if (data.app_id !== process.env.ALIPAY_APP_ID) {
      throw new Error(`app_id 不匹配: ${data.app_id} !== ${process.env.ALIPAY_APP_ID}`);
    }

    const tradeStatus = data.trade_status;
    const status: VerifiedNotify["status"] =
      tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED" ? "paid" : "other";

    return {
      orderNo: data.out_trade_no,
      thirdPartyNo: data.trade_no,
      amount: Number(data.total_amount || data.buyer_pay_amount || "0"),
      paidAt: new Date(),
      status,
    };
  }

  async queryOrder(order: BillingOrder): Promise<{
    status: VerifiedNotify["status"];
    thirdPartyNo?: string;
    paidAt?: Date;
  }> {
    console.log(`[Alipay] queryOrder order_no=${order.order_no} dryRun=${this.isDryRun()}`);
    if (this.isDryRun()) {
      return { status: "other" };
    }

    const timestamp = formatDate(new Date(), "YYYY-MM-DD HH:mm:ss");
    const bizContent = JSON.stringify({ out_trade_no: order.order_no });

    const params: Record<string, string> = {
      app_id: process.env.ALIPAY_APP_ID!,
      method: "alipay.trade.query",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp,
      version: "1.0",
      biz_content: bizContent,
    };

    params.sign = this._signRsa2(params);

    const gateway = process.env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do";
    const response = await fetch(gateway, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(),
    });

    const result = await response.json() as any;
    const alipayResp = result.alipay_trade_query_response;

    if (!alipayResp || alipayResp.code !== "10000") {
      console.log(`[Alipay] 查询失败: ${alipayResp?.msg || "未知错误"}`);
      return { status: "other" };
    }

    const tradeStatus = alipayResp.trade_status;
    const status = tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED" ? "paid" : "other";

    return {
      status,
      thirdPartyNo: alipayResp.trade_no,
      paidAt: status === "paid" ? new Date(alipayResp.send_pay_date || Date.now()) : undefined,
    };
  }

  private _signRsa2(params: Record<string, string>): string {
    const content = this._buildSignContent(params);
    const privateKey = this._loadPrivateKey();

    const sign = crypto.createSign("RSA-SHA256");
    sign.update(content, "utf8");
    return sign.sign(privateKey, "base64");
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
    const sortedKeys = Object.keys(params).sort();
    const pairs: string[] = [];

    for (const key of sortedKeys) {
      const value = params[key];
      if (value === "" || value === undefined) continue;
      pairs.push(`${key}=${value}`);
    }

    return pairs.join("&");
  }

  private _loadPrivateKey(): string {
    const inline = process.env.ALIPAY_APP_PRIVATE_KEY;
    if (inline) {
      return this._wrapPem(inline, "RSA PRIVATE KEY");
    }

    const keyPath = process.env.ALIPAY_APP_PRIVATE_KEY_PATH;
    if (keyPath) {
      const fullPath = path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);
      console.log(`[Alipay] 从文件加载私钥: ${fullPath}`);
      return fs.readFileSync(fullPath, "utf8");
    }

    throw new Error("ALIPAY_APP_PRIVATE_KEY 与 ALIPAY_APP_PRIVATE_KEY_PATH 都未配置");
  }

  private _loadAlipayPublicKey(): string {
    const inline = process.env.ALIPAY_PUBLIC_KEY;
    if (inline) {
      return this._wrapPem(inline, "PUBLIC KEY");
    }

    const certDir = path.join(process.cwd(), "certs");
    const certPath = path.join(certDir, "alipay_public_key.pem");
    if (fs.existsSync(certPath)) {
      console.log(`[Alipay] 从文件加载公钥: ${certPath}`);
      return fs.readFileSync(certPath, "utf8");
    }

    throw new Error("ALIPAY_PUBLIC_KEY 未配置且 certs/alipay_public_key.pem 不存在");
  }

  private _wrapPem(b64: string, type: string): string {
    if (b64.includes("BEGIN")) return b64;
    const lines = b64.match(/.{1,64}/g) || [];
    return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
  }
}

function formatDate(date: Date, fmt: string): string {
  const map: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: String(date.getMonth() + 1).padStart(2, "0"),
    DD: String(date.getDate()).padStart(2, "0"),
    HH: String(date.getHours()).padStart(2, "0"),
    mm: String(date.getMinutes()).padStart(2, "0"),
    ss: String(date.getSeconds()).padStart(2, "0"),
  };
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (match) => map[match]);
}

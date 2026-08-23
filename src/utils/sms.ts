/**
 * 短信验证码发送
 *
 * 阿里云 4 项配置齐全时,无论开发/生产都真实下发短信(移植自 website_backend):
 *   SMS_PROVIDER=aliyun
 *   ALIYUN_SMS_ACCESS_KEY_ID
 *   ALIYUN_SMS_ACCESS_KEY_SECRET
 *   ALIYUN_SMS_SIGN_NAME        - 短信签名(如 "xxx")
 *   ALIYUN_SMS_TEMPLATE_CODE    - 短信模板 ID(如 "SMS_xxxx")
 *
 * 配置缺失或发送失败时:
 *   - 开发环境:降级打印控制台,并返回 devCode 供本地联调
 *   - 生产环境:返回 delivered=false,不静默放行
 */

import crypto from "crypto";

export interface SmsSendResult {
  delivered: boolean;
  devCode?: string;
}

const isDev = () => process.env.NODE_ENV !== "production";

export async function sendSmsCode(
  phone: string,
  code: string
): Promise<SmsSendResult> {
  const provider = (process.env.SMS_PROVIDER || "aliyun").toLowerCase();

  if (provider === "aliyun") {
    const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET;
    const signName = process.env.ALIYUN_SMS_SIGN_NAME;
    const templateCode = process.env.ALIYUN_SMS_TEMPLATE_CODE;

    if (accessKeyId && accessKeySecret && signName && templateCode) {
      try {
        const delivered = await sendViaAliyun(
          accessKeyId,
          accessKeySecret,
          signName,
          templateCode,
          phone,
          code
        );
        if (delivered) {
          // 开发环境把验证码一并打印，方便本地联调（生产不打印，避免验证码泄漏进日志）
          console.log(
            `📱 [SMS] 阿里云短信已下发 phone=${maskPhone(phone)}${
              isDev() ? ` code=${code}` : ""
            }`
          );
          // 真实短信成功下发后,不再返回 devCode(避免前端误用开发验证码)
          return { delivered: true };
        }
      } catch (error) {
        console.error("[SMS] ✖ 阿里云短信发送抛异常:", error);
      }
    } else {
      console.warn(
        `[SMS] ⚠ 阿里云配置不完整(AK=${!!accessKeyId} Secret=${!!accessKeySecret} Sign=${!!signName} Template=${!!templateCode}),降级到 dev 模式`
      );
    }
  }

  // 未成功下发:开发环境打印验证码并返回 devCode 供联调;生产环境返回失败
  if (isDev()) {
    console.log(`\n📱 [DEV-SMS] phone=${phone} code=${code}（5 分钟内有效）\n`);
    return { delivered: true, devCode: code };
  }
  console.error(`[SMS] 生产环境短信发送失败,phone=${maskPhone(phone)}`);
  return { delivered: false };
}

/**
 * 通过阿里云短信服务发送验证码
 *  - 开放 API: https://dysmsapi.aliyuncs.com
 *  - 签名方式: HMAC-SHA1(与 website_backend 一致)
 */
async function sendViaAliyun(
  accessKeyId: string,
  accessKeySecret: string,
  signName: string,
  templateCode: string,
  phone: string,
  code: string
): Promise<boolean> {
  const params: Record<string, string> = {
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
    Action: "SendSms",
    Version: "2017-05-25",
    Format: "JSON",
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  // 排序参数并计算签名
  const sortedKeys = Object.keys(params).sort();
  const canonicalizedQueryString = sortedKeys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");

  const stringToSign = `GET&${encodeURIComponent("/")}&${encodeURIComponent(canonicalizedQueryString)}`;
  const signature = crypto
    .createHmac("sha1", accessKeySecret + "&")
    .update(stringToSign)
    .digest("base64");

  const url = `https://dysmsapi.aliyuncs.com/?${canonicalizedQueryString}&Signature=${encodeURIComponent(signature)}`;
  console.log(`[SMS] >>> 阿里云 SendSms ${maskPhone(phone)} sign=${signName} template=${templateCode}`);

  const response = await fetch(url);
  const rawText = await response.text();
  console.log(`[SMS] <<< HTTP ${response.status} body=${rawText}`);

  let result: { Code?: string; Message?: string; RequestId?: string };
  try {
    result = JSON.parse(rawText);
  } catch {
    console.error("[SMS] ✖ 阿里云响应体不是 JSON");
    return false;
  }

  if (result.Code === "OK") {
    console.log(`[SMS] ✅ 短信发送成功 RequestId=${result.RequestId}`);
    return true;
  }
  console.error(`[SMS] ❌ 短信发送失败 ${result.Code} - ${result.Message}`);
  return false;
}

function maskPhone(phone: string): string {
  if (phone.length < 7) return "***";
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

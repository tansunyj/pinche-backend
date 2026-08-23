/**
 * 短信验证码服务（验证码存 Redis；通道默认走阿里云，可扩展腾讯云等）
 *
 * 配置（在 backend/.env 里填，留空即降级到 dev 模式：验证码不真正下发，只在日志里看见）：
 *   ALIYUN_SMS_ACCESS_KEY_ID
 *   ALIYUN_SMS_ACCESS_KEY_SECRET
 *   ALIYUN_SMS_SIGN_NAME       - 短信签名（如 "SiliEvo"）
 *   ALIYUN_SMS_TEMPLATE_CODE   - 短信模板 ID（如 "SMS_123456"）
 *   SMS_PROVIDER               - "aliyun" | "tencent"（默认 aliyun）；其他通道按需扩展
 *
 * 复用入口：
 *   - generateCode()                   生成 6 位数字验证码
 *   - sendSmsCode(phone, code)         发短信 + 写 Redis（带频率限制）
 *   - verifyCode(phone, code)          校验，成功后即删
 */

import crypto from "crypto";
import redis from "./redis";

const CODE_EXPIRY_SECONDS = 5 * 60; // 5 分钟
const SEND_INTERVAL_SECONDS = 60; // 60 秒发送间隔
const MAX_VERIFY_ATTEMPTS = 5;

const codeKey = (phone: string) => `sms:code:${phone}`;
const limitKey = (phone: string) => `sms:limit:${phone}`;
const attemptsKey = (phone: string) => `sms:attempts:${phone}`;

/**
 * 生成 6 位随机验证码
 */
export function generateCode(): string {
  return Math.random().toString().slice(2, 8);
}

/**
 * 发送短信验证码
 * @returns 是否发送成功
 */
export async function sendSmsCode(
  phone: string,
  code: string
): Promise<boolean> {
  console.log(`\n========== [SMS] sendSmsCode 开始 ==========`);
  console.log(`[SMS] 手机号: ${phone}`);
  console.log(`[SMS] 验证码(明文): ${code}`);

  // 检查发送频率限制（Redis 上 60s TTL 存在 → 拒绝）
  const limited = await redis.get(limitKey(phone));
  if (limited) {
    console.log(`[SMS] ✖ 频率限制命中（距上次发送不足 60s）`);
    throw new Error("发送太频繁，请60秒后重试");
  }

  // 写入验证码（5min TTL）+ 频率锁（60s TTL）
  await redis.setex(codeKey(phone), CODE_EXPIRY_SECONDS, hashCode(code));
  await redis.setex(limitKey(phone), SEND_INTERVAL_SECONDS, "1");
  await redis.del(attemptsKey(phone));
  console.log(`[SMS] 验证码已写入 Redis (key=${codeKey(phone)}, TTL=${CODE_EXPIRY_SECONDS}s)`);

  // 选择通道：默认阿里云
  const provider = (process.env.SMS_PROVIDER || "aliyun").toLowerCase();

  if (provider === "aliyun") {
    const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET;
    const signName = process.env.ALIYUN_SMS_SIGN_NAME;
    const templateCode = process.env.ALIYUN_SMS_TEMPLATE_CODE;

    console.log(`[SMS] 通道: aliyun`);
    console.log(`[SMS] AccessKeyId    = ${accessKeyId ? maskMiddle(accessKeyId) : "<未配置>"}`);
    console.log(`[SMS] AccessKeySecret= ${accessKeySecret ? maskMiddle(accessKeySecret) : "<未配置>"}`);
    console.log(`[SMS] SignName       = ${signName || "<未配置>"}`);
    console.log(`[SMS] TemplateCode   = ${templateCode || "<未配置>"}`);

    if (accessKeyId && accessKeySecret && signName && templateCode) {
      try {
        return await sendViaAliyun(accessKeyId, accessKeySecret, signName, templateCode, phone, code);
      } catch (error) {
        console.error("[SMS] ✖ 阿里云短信发送抛异常:", error);
        return false;
      }
    } else {
      console.warn("[SMS] ⚠ 阿里云 4 个参数未全部配置，降级到 dev 模式");
    }
  }

  // 通道未配置：dev 模式，验证码已写入 Redis 但短信未真正下发
  console.warn(`[SMS] 短信服务未配置（provider=${provider}），验证码未下发。手机号: ${maskPhone(phone)}`);
  // 仅在 NODE_ENV != production 时打印明文，便于本地联调
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[SMS] (dev only) ${maskPhone(phone)} 验证码：${code}`);
  }
  return false;
}

/**
 * 验证验证码（异步：从 Redis 取）
 */
export async function verifyCode(phone: string, code: string): Promise<boolean> {
  console.log(`\n========== [SMS] verifyCode 开始 ==========`);
  console.log(`[SMS] phone=${phone}，input code=${code}`);

  const storedHash = await redis.get(codeKey(phone));
  if (!storedHash) {
    console.warn(`[SMS] ✖ Redis 里没有该手机号的验证码（未发送 或 已过期）`);
    return false;
  }

  // 限制尝试次数：超过即清除
  const attemptsRaw = await redis.get(attemptsKey(phone));
  const attempts = attemptsRaw ? parseInt(attemptsRaw, 10) || 0 : 0;
  console.log(`[SMS] 该手机号已尝试次数: ${attempts}/${MAX_VERIFY_ATTEMPTS}`);

  if (attempts >= MAX_VERIFY_ATTEMPTS) {
    await redis.del(codeKey(phone), attemptsKey(phone));
    console.warn(`[SMS] ✖ 尝试次数超限，验证码已作废`);
    return false;
  }

  const inputHash = hashCode(code);
  console.log(`[SMS] storedHash=${storedHash.slice(0, 8)}..., inputHash=${inputHash.slice(0, 8)}...`);

  if (storedHash !== inputHash) {
    await redis.setex(attemptsKey(phone), CODE_EXPIRY_SECONDS, String(attempts + 1));
    console.warn(`[SMS] ✖ 验证码不匹配`);
    return false;
  }

  // 验证成功后清理
  await redis.del(codeKey(phone), attemptsKey(phone));
  console.log(`[SMS] ✓ 验证成功，Redis 里的验证码已清理`);
  return true;
}

/**
 * 通过阿里云短信服务发送验证码
 */
async function sendViaAliyun(
  accessKeyId: string,
  accessKeySecret: string,
  signName: string,
  templateCode: string,
  phone: string,
  code: string
): Promise<boolean> {
  // 使用阿里云 OpenAPI 发送短信
  // 阿里云短信 API: https://dysmsapi.aliyuncs.com
  const params = {
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

  console.log(`[SMS][Aliyun] >>> 业务参数:`, {
    PhoneNumbers: params.PhoneNumbers,
    SignName: params.SignName,
    TemplateCode: params.TemplateCode,
    TemplateParam: params.TemplateParam,
    SignatureNonce: params.SignatureNonce,
    Timestamp: params.Timestamp,
  });

  // 排序参数并计算签名
  const sortedKeys = Object.keys(params).sort();
  const canonicalizedQueryString = sortedKeys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key as keyof typeof params])}`)
    .join("&");

  const stringToSign = `GET&${encodeURIComponent("/")}&${encodeURIComponent(canonicalizedQueryString)}`;
  console.log(`[SMS][Aliyun] StringToSign: ${stringToSign}`);

  const signature = crypto
    .createHmac("sha1", accessKeySecret + "&")
    .update(stringToSign)
    .digest("base64");
  console.log(`[SMS][Aliyun] Signature: ${signature}`);

  const url = `https://dysmsapi.aliyuncs.com/?${canonicalizedQueryString}&Signature=${encodeURIComponent(signature)}`;
  // 掩揉出去的 URL 里的 AccessKeyId，避免全量泄露
  console.log(`[SMS][Aliyun] >>> Request URL: ${url.replace(accessKeyId, maskMiddle(accessKeyId))}`);

  const startedAt = Date.now();
  const response = await fetch(url);
  const rawText = await response.text();
  const elapsed = Date.now() - startedAt;

  console.log(`[SMS][Aliyun] <<< HTTP ${response.status}，耗时 ${elapsed}ms`);
  console.log(`[SMS][Aliyun] <<< Raw Body: ${rawText}`);

  let result: { Code?: string; Message?: string; RequestId?: string; BizId?: string };
  try {
    result = JSON.parse(rawText);
  } catch (e) {
    console.error(`[SMS][Aliyun] ✖ 响应体不是 JSON，原始文本如上`);
    return false;
  }

  console.log(`[SMS][Aliyun] <<< 解析后:`, result);

  if (result.Code === "OK") {
    console.log(`[SMS][Aliyun] ✅ 短信发送成功: ${phone} (RequestId=${result.RequestId}, BizId=${result.BizId})`);
    return true;
  } else {
    console.error(`[SMS][Aliyun] ❌ 短信发送失败: ${result.Code} - ${result.Message} (RequestId=${result.RequestId})`);
    return false;
  }
}

/**
 * 中间掩揉出敦友好的预览字符串，用于日志环境不泄露账号凭证
 */
function maskMiddle(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return s.replace(/./g, "*");
  return `${s.slice(0, 4)}${"*".repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function maskPhone(phone: string): string {
  if (phone.length < 7) {
    return "***";
  }

  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

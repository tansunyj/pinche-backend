/**
 * 邮箱验证码发送（移植自 website_backend/src/utils/mailer.ts）
 *
 * SMTP 4 项配置齐全时真实发送邮件（dev/prod 一致）：
 *   SMTP_HOST          - 例：smtp.qq.com / smtp.gmail.com / smtpdm.aliyun.com
 *   SMTP_PORT          - 通常 465(SSL) 或 587(STARTTLS)
 *   SMTP_SECURE        - "true" 强制 SSL；端口 465 时建议 true
 *   SMTP_USER          - 登录账号（一般是发件邮箱）
 *   SMTP_PASS          - 登录密码 / 授权码（QQ/163 必须用授权码）
 *   SMTP_FROM_NAME     - 发件人显示名（如 "Token拼车"）
 *
 * 配置缺失或发送失败时：
 *   - 开发环境：降级打印控制台，并返回 devCode 供本地联调
 *   - 生产环境：返回 delivered=false，不静默放行
 */

import nodemailer, { Transporter } from "nodemailer";

export interface MailSendResult {
  delivered: boolean;
  devCode?: string;
}

const isDev = () => process.env.NODE_ENV !== "production";

let cachedTransporter: Transporter | null = null;
let transporterChecked = false;

function getTransporter(): Transporter | null {
  if (transporterChecked) return cachedTransporter;
  transporterChecked = true;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.warn(
      `[MAIL] ⚠ SMTP_* 未配置（host=${host || "<空>"}, user=${user || "<空>"}, pass=${pass ? "<已填>" : "<空>"}）→ 邮件不真发，仅打到控制台。`
    );
    return null;
  }

  const port = Number(process.env.SMTP_PORT) || 465;
  const secure =
    typeof process.env.SMTP_SECURE === "string"
      ? process.env.SMTP_SECURE === "true"
      : port === 465;

  console.log(`[MAIL] 初始化 SMTP transporter: host=${host}, port=${port}, secure=${secure}, user=${user}`);

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  return cachedTransporter;
}

function formatFrom(): string {
  const name = process.env.SMTP_FROM_NAME || "Token拼车";
  const address = process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER || "";
  return address ? `"${name}" <${address}>` : name;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

function renderCodeMail(code: string, expiresInMinutes: number): string {
  return `<!doctype html><html><body style="background:#f6f7fb;padding:32px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table align="center" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px;text-align:center;">
      <tr><td>
        <h2 style="margin:0 0 8px 0;font-size:18px;">Token 拼车 验证码</h2>
        <p style="margin:0 0 24px 0;color:#6b7280;font-size:13px;">您正在进行身份验证，请在页面输入下方验证码：</p>
        <div style="font-size:32px;letter-spacing:8px;font-weight:700;color:#111827;font-family:Menlo,Consolas,monospace;margin:8px 0 24px 0;">${escapeHtml(code)}</div>
        <p style="margin:0;color:#9ca3af;font-size:12px;">验证码 ${expiresInMinutes} 分钟内有效，请勿告知他人。如非本人操作，请忽略本邮件。</p>
      </td></tr>
    </table>
  </body></html>`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 发送 6 位邮箱验证码（登录/注册场景）。
 * 成功真实发送后不返回 devCode；未配置/失败时 dev 环境返回 devCode 供联调。
 */
export async function sendVerifyCodeMail(
  to: string,
  code: string,
  options?: { subject?: string; expiresInMinutes?: number }
): Promise<MailSendResult> {
  const subject = options?.subject || "【Token拼车】邮箱验证码";
  const expiresIn = options?.expiresInMinutes ?? 5;
  const html = renderCodeMail(code, expiresIn);
  const text = `您的验证码是 ${code}，${expiresIn} 分钟内有效。如非本人操作，请忽略本邮件。`;

  const transporter = getTransporter();
  if (!transporter) {
    if (isDev()) {
      console.log(`\n📧 [DEV-MAIL] to=${to} code=${code}（${expiresIn} 分钟内有效）\n`);
      return { delivered: true, devCode: code };
    }
    console.error(`[MAIL] 生产环境 SMTP 未配置，验证码未发送 to=${to}`);
    return { delivered: false };
  }

  try {
    const info = await transporter.sendMail({
      from: formatFrom(),
      to,
      subject,
      html,
      text,
    });
    console.log(`[MAIL] ✓ 验证码邮件已发送 to=${to} messageId=${info.messageId}`);
    return { delivered: true };
  } catch (err: any) {
    console.error(`[MAIL] ✖ SMTP 发送失败 to=${to}:`, err?.message || err);
    return { delivered: false };
  }
}

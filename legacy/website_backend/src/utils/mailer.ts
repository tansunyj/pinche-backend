/**
 * 邮件服务（基于 nodemailer SMTP）
 *
 * 配置方式（在 backend/.env 里填，全部留空即降级到 console 日志输出）：
 *   SMTP_HOST          - 例：smtp.qq.com / smtp.gmail.com / smtp.feishu.cn / smtpdm.aliyun.com
 *   SMTP_PORT          - 通常 465(SSL) 或 587(STARTTLS)
 *   SMTP_SECURE        - "true" 强制 SSL；端口 465 时建议 true
 *   SMTP_USER          - 登录账号（一般是发件邮箱地址）
 *   SMTP_PASS          - 登录密码 / 授权码（QQ/163 必须用授权码）
 *   SMTP_FROM_NAME     - 发件人显示名（如 "SiliEvo"）
 *   SMTP_FROM_ADDRESS  - 发件人邮箱（一般等于 SMTP_USER）
 *
 * 调试开关：
 *   MAIL_DRY_RUN=true  - 即使 SMTP_* 填了也不真发，只打印详细日志
 */

import nodemailer, { Transporter } from "nodemailer";

function isDryRun(): boolean {
  return (process.env.MAIL_DRY_RUN || "").toLowerCase() === "true";
}

type MailResult = {
  delivered: boolean;
  previewUrl?: string;
};

let cachedTransporter: Transporter | null = null;
let transporterChecked = false;

function getTransporter(): Transporter | null {
  if (transporterChecked) return cachedTransporter;
  transporterChecked = true;

  if (isDryRun()) {
    console.warn("[MAIL] MAIL_DRY_RUN=true → 强制 dev 模式，邮件不真发。");
    return null;
  }

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.warn(
      `[MAIL] SMTP_* 未配置（host=${host || "<空>"}, user=${user || "<空>"}, pass=${pass ? "<已填>" : "<空>"}）→ 邮件不真发，仅打到控制台。`
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
  const name = process.env.SMTP_FROM_NAME || "SiliEvo";
  const address = process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER || "";
  return address ? `"${name}" <${address}>` : name;
}

/**
 * 通用发送（HTML + 纯文本备用）
 */
export async function sendMail(
  to: string,
  subject: string,
  html: string,
  text?: string,
): Promise<MailResult> {
  console.log(`\n========== [MAIL] sendMail 开始 ==========`);
  console.log(`[MAIL] from   : ${formatFrom()}`);
  console.log(`[MAIL] to     : ${to}`);
  console.log(`[MAIL] subject: ${subject}`);
  if (text) console.log(`[MAIL] text   : ${text}`);

  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`[MAIL] ⚠ 未真实下发（dev/dry-run 模式），仅记录在日志中`);
    console.log(`========== [MAIL] sendMail 结束 (delivered=false) ==========\n`);
    return { delivered: false };
  }

  try {
    const startedAt = Date.now();
    const info = await transporter.sendMail({
      from: formatFrom(),
      to,
      subject,
      html,
      text: text || stripHtml(html),
    });
    console.log(`[MAIL] ✓ SMTP 接收成功，耗时 ${Date.now() - startedAt}ms`);
    console.log(`[MAIL] 响应 messageId : ${info.messageId}`);
    console.log(`[MAIL] 响应 response  : ${info.response}`);
    if (info.accepted?.length) console.log(`[MAIL] 接收人 accepted : ${info.accepted.join(", ")}`);
    if (info.rejected?.length) console.warn(`[MAIL] 接收人 rejected : ${info.rejected.join(", ")}`);
    console.log(`========== [MAIL] sendMail 结束 (delivered=true) ==========\n`);
    return { delivered: true };
  } catch (err: any) {
    console.error(`[MAIL] ✖ SMTP 发送失败:`, err?.message || err);
    if (err?.response) console.error(`[MAIL] SMTP 服务器响应: ${err.response}`);
    if (err?.code) console.error(`[MAIL] 错误码: ${err.code}`);
    console.log(`========== [MAIL] sendMail 结束 (delivered=false) ==========\n`);
    return { delivered: false };
  }
}

/**
 * 旧接口：发送带操作按钮的邮件（注册验证、找回密码等点击链接式流程）
 */
export async function sendAuthMail(
  to: string,
  subject: string,
  actionText: string,
  actionUrl: string,
): Promise<MailResult> {
  console.log(`\n========== [MAIL] sendAuthMail (链接式) ==========`);
  console.log(`[MAIL] to        : ${to}`);
  console.log(`[MAIL] subject   : ${subject}`);
  console.log(`[MAIL] actionText: ${actionText}`);
  console.log(`[MAIL] 🔗 actionUrl : ${actionUrl}`);

  const html = renderActionMail(subject, actionText, actionUrl);
  const transporter = getTransporter();
  if (!transporter) {
    // dev / dry-run：将链接当 previewUrl 返回，便于前端调试
    console.warn(`[MAIL] ⚠ 未真实下发，previewUrl 返回为上述 actionUrl，可直接复制到浏览器访问`);
    console.log(`========== [MAIL] sendAuthMail 结束 (delivered=false) ==========\n`);
    return { delivered: false, previewUrl: actionUrl };
  }
  return sendMail(to, subject, html, `${actionText}: ${actionUrl}`);
}

/**
 * 发送 6 位邮箱验证码（注册 / 修改密码 / 绑定邮箱等场景）
 */
export async function sendVerifyCodeMail(
  to: string,
  code: string,
  options?: { subject?: string; expiresInMinutes?: number },
): Promise<MailResult> {
  const subject = options?.subject || "SiliEvo 邮箱验证码";
  const expiresIn = options?.expiresInMinutes ?? 5;
  console.log(`\n========== [MAIL] sendVerifyCodeMail (验证码式) ==========`);
  console.log(`[MAIL] to        : ${to}`);
  console.log(`[MAIL] subject   : ${subject}`);
  console.log(`[MAIL] 🔑 code      : ${code}`);
  console.log(`[MAIL] expiresIn : ${expiresIn} 分钟`);
  const html = renderCodeMail(code, expiresIn);
  const text = `您的验证码是 ${code}，${expiresIn} 分钟内有效。如非本人操作，请忽略本邮件。`;
  return sendMail(to, subject, html, text);
}

// ============================================
// 模板（极简内联样式，主流邮箱客户端兼容）
// ============================================

function renderActionMail(title: string, actionText: string, actionUrl: string): string {
  return `<!doctype html><html><body style="background:#f6f7fb;padding:32px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table align="center" width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px;">
      <tr><td>
        <h2 style="margin:0 0 12px 0;font-size:18px;">${escapeHtml(title)}</h2>
        <p style="margin:0 0 24px 0;color:#4b5563;font-size:14px;line-height:1.6;">点击下方按钮完成操作（10 分钟内有效）。如非本人操作，请忽略本邮件。</p>
        <p style="text-align:center;margin:0 0 24px 0;">
          <a href="${actionUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:14px;">${escapeHtml(actionText)}</a>
        </p>
        <p style="margin:0;color:#9ca3af;font-size:12px;word-break:break-all;">如按钮无法点击，请复制以下链接到浏览器：<br/>${actionUrl}</p>
      </td></tr>
    </table>
  </body></html>`;
}

function renderCodeMail(code: string, expiresInMinutes: number): string {
  return `<!doctype html><html><body style="background:#f6f7fb;padding:32px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table align="center" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px;text-align:center;">
      <tr><td>
        <h2 style="margin:0 0 8px 0;font-size:18px;">SiliEvo 验证码</h2>
        <p style="margin:0 0 24px 0;color:#6b7280;font-size:13px;">您正在进行身份验证，请在页面输入下方验证码：</p>
        <div style="font-size:32px;letter-spacing:8px;font-weight:700;color:#111827;font-family:Menlo,Consolas,monospace;margin:8px 0 24px 0;">${escapeHtml(code)}</div>
        <p style="margin:0;color:#9ca3af;font-size:12px;">验证码 ${expiresInMinutes} 分钟内有效，请勿告知他人。如非本人操作，请忽略本邮件。</p>
      </td></tr>
    </table>
  </body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}


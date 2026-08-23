import jwt, { SignOptions } from "jsonwebtoken";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const invalidSecrets = new Set([
    "",
    "fallback-secret-key",
    "your-super-secret-jwt-key-change-this-in-production",
    "replace-with-a-long-random-secret",
  ]);

  if (!secret) {
    throw new Error(
      "JWT_SECRET 未配置：.env 中找不到 JWT_SECRET 变量。请确认：\n" +
        "  1. .env 文件位于 silievo-site/backend/.env\n" +
        "  2. 包含一行 `JWT_SECRET=<至少32位的随机串>`（无引号也可）\n" +
        "  3. 改完后完全重启 dev server（Ctrl+C 后 `npm run dev`）"
    );
  }
  if (invalidSecrets.has(secret)) {
    throw new Error(
      `JWT_SECRET 仍为占位/弱默认值（"${secret.slice(0, 30)}..."），请改成你自己的随机串。`
    );
  }
  if (secret.length < 16) {
    throw new Error(
      `JWT_SECRET 长度过短（当前 ${secret.length} 位），至少需要 16 位（推荐 32 位以上）。`
    );
  }

  return secret;
}

const JWT_SECRET = getJwtSecret();
const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || `${JWT_SECRET}_refresh`;
const REFRESH_TOKEN_EXPIRES_IN: string = process.env.REFRESH_TOKEN_EXPIRES_IN || "30d";

export interface TokenPayload {
  userId: number;
  email: string | null;
  userType: number; // 1=普通/2=管理员/3=超管
  role?: string; // 兼容旧代码
}

export function generateToken(payload: TokenPayload): string {
  const options: SignOptions = { expiresIn: JWT_EXPIRES_IN as any };
  return jwt.sign(payload, JWT_SECRET, options);
}

export function generateRefreshToken(payload: TokenPayload): string {
  const options: SignOptions = { expiresIn: REFRESH_TOKEN_EXPIRES_IN as any };
  return jwt.sign(payload, REFRESH_TOKEN_SECRET, options);
}

/**
 * 通用的 Token 签发函数
 * @param payload - Token 数据
 * @param secret - 签名密钥（可选，默认使用 JWT_SECRET）
 * @param options - 签发选项
 */
export function signToken(
  payload: Record<string, any>,
  secret: string = JWT_SECRET,
  options: { expiresIn?: string } = {}
): string {
  const signOptions: SignOptions = { expiresIn: options.expiresIn || JWT_EXPIRES_IN as any };
  return jwt.sign(payload, secret, signOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, REFRESH_TOKEN_SECRET) as TokenPayload;
}

/**
 * 用户端 JWT 签发/验证（复用老 website_backend 语义）
 *
 * - access token：默认 15m，payload 含 userId / phone / userType
 * - refresh token：默认 30d，独立 secret，仅用于刷新 access
 */

import jwt, { SignOptions } from "jsonwebtoken";

function getSecret(name: string): string {
  const secret = process.env[name];
  if (!secret || secret.length < 16) {
    throw new Error(`${name} 未配置或长度不足 16 位，请检查 .env`);
  }
  return secret;
}

const JWT_SECRET = getSecret("JWT_SECRET");
const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || `${JWT_SECRET}_refresh`;
const REFRESH_TOKEN_EXPIRES_IN: string = process.env.REFRESH_TOKEN_EXPIRES_IN || "30d";

export interface TokenPayload {
  userId: number; // pt_users.id（拼车唯一用户表）
  phone: string | null;
  email?: string | null;
  userType: number; // 1=普通用户
  role?: string;
}

export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });
}

export function generateRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES_IN as any });
}

export function signToken(
  payload: Record<string, any>,
  secret: string = JWT_SECRET,
  options: { expiresIn?: string } = {}
): string {
  const signOptions: SignOptions = { expiresIn: options.expiresIn || (JWT_EXPIRES_IN as any) };
  return jwt.sign(payload, secret, signOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, REFRESH_TOKEN_SECRET) as TokenPayload;
}

import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Response } from "express";
import { generateRefreshToken, generateToken, TokenPayload } from "./auth";
import redis from "./redis";
import type { UserRow } from "../services/UserService";

const COOKIE_SECURE = process.env.NODE_ENV === "production";
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天
const ACCESS_TTL_MS = 15 * 60 * 1000; // 15 分钟（与 JWT_EXPIRES_IN 一致）

export function buildAuthPayload(user: UserRow): TokenPayload {
  return {
    userId: user.id,
    email: user.email,
    userType: user.user_type,
  };
}

/**
 * 颁发会话：生成 access + refresh token，refresh hash 存 Redis（不污染 user_users 表）
 */
export async function issueAuthSession(user: UserRow, res: Response) {
  const payload = buildAuthPayload(user);
  const accessToken = generateToken(payload);
  const refreshToken = generateRefreshToken(payload);
  const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

  await redis.setex(
    `refresh:${user.id}`,
    REFRESH_TTL_SECONDS,
    refreshTokenHash
  );

  res.cookie("auth_token", accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: ACCESS_TTL_MS,
    path: "/",
  });

  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: REFRESH_TTL_SECONDS * 1000,
    path: "/api/auth",
  });

  return { accessToken, refreshToken };
}

export async function revokeRefreshToken(userId: number): Promise<void> {
  await redis.del(`refresh:${userId}`);
}

export async function matchesRefreshToken(
  userId: number,
  refreshToken: string
): Promise<boolean> {
  const hash = await redis.get(`refresh:${userId}`);
  if (!hash) return false;
  return bcrypt.compare(refreshToken, hash);
}

export function clearAuthCookies(res: Response) {
  res.clearCookie("auth_token", { path: "/" });
  res.clearCookie("refresh_token", { path: "/api/auth" });
}

// ============ 一次性 token（邮箱验证、密码重置）============

export function createRandomToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * 存储一次性 token 到 Redis，返回原始 token；调用方把 token 发给用户
 */
export async function storeOneTimeToken(opts: {
  scope: "email_verify" | "pwd_reset";
  userId: number;
  ttlSeconds: number;
}): Promise<string> {
  const token = createRandomToken();
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await redis.setex(
    `${opts.scope}:${tokenHash}`,
    opts.ttlSeconds,
    String(opts.userId)
  );
  return token;
}

/**
 * 校验一次性 token：成功返回 userId，并立即作废；失败返回 null
 */
export async function consumeOneTimeToken(opts: {
  scope: "email_verify" | "pwd_reset";
  token: string;
}): Promise<number | null> {
  const tokenHash = crypto
    .createHash("sha256")
    .update(opts.token)
    .digest("hex");
  const key = `${opts.scope}:${tokenHash}`;
  const userIdStr = await redis.get(key);
  if (!userIdStr) return null;
  await redis.del(key);
  const userId = Number(userIdStr);
  return Number.isFinite(userId) ? userId : null;
}

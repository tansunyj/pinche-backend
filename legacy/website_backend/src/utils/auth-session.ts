import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Response } from "express";
import pool from "../db/mysql";
import { generateRefreshToken, generateToken, TokenPayload } from "./auth";

// 本地定义 User 类型（替代 Prisma User）
interface User {
  id: number;
  username: string;
  email: string;
  emailVerified: Date | null;
  phone: string | null;
  phoneVerified: Date | null;
  role: string;
  siliconCoins: number;
  avatar: string | null;
  bio: string | null;
  userType: number;
}

const COOKIE_SECURE = process.env.NODE_ENV === "production";

export function buildAuthPayload(user: User): TokenPayload {
  return {
    userId: user.id,
    email: user.email,
    userType: user.userType,
    role: user.role,
  };
}

export function getPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    phone: user.phone,
    phoneVerified: user.phoneVerified,
    role: user.role,
    siliconCoins: user.siliconCoins,
    avatar: user.avatar,
    bio: user.bio,
  };
}

export async function issueAuthSession(user: User, res: Response) {
  const payload = buildAuthPayload(user);
  const accessToken = generateToken(payload);
  const refreshToken = generateRefreshToken(payload);
  const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

  // 使用 MySQL 更新 refreshTokenHash
  await pool.execute(
    "UPDATE user_users SET refresh_token_hash = ? WHERE id = ?",
    [refreshTokenHash, user.id]
  );

  res.cookie("auth_token", accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: 15 * 60 * 1000,
    path: "/",
  });

  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/api/auth",
  });

  return { accessToken, refreshToken };
}

export function clearAuthCookies(res: Response) {
  res.clearCookie("auth_token", { path: "/" });
  res.clearCookie("refresh_token", { path: "/api/auth" });
}

export function createRandomToken() {
  return crypto.randomBytes(32).toString("hex");
}

export async function hashToken(token: string) {
  return bcrypt.hash(token, 10);
}

export async function matchesToken(token: string, hash?: string | null) {
  if (!hash) return false;
  return bcrypt.compare(token, hash);
}


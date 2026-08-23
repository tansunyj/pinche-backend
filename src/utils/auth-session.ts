/**
 * 会话管理：access + refresh token 双 token 机制（复用老 auth-session-mysql 语义）
 *
 *  - access token：JWT，15m，存 HttpOnly cookie（auth_token）+ 可放 Authorization 头
 *  - refresh token：JWT，30d，hash 存 Redis `pt:refresh:{userId}`，仅 cookie 传输
 *  - 登出/改密时 revoke refresh，并把 access 加入黑名单 `pt:bl:{token}`
 */

import bcrypt from "bcryptjs";
import { Response } from "express";
import { generateRefreshToken, generateToken, TokenPayload } from "./jwt";
import redis from "./redis";
import type { UserRow } from "../services/user";

const COOKIE_SECURE = process.env.NODE_ENV === "production";
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天
const ACCESS_TTL_MS = 15 * 60 * 1000; // 15 分钟

export function buildAuthPayload(user: UserRow): TokenPayload {
  return {
    userId: user.id, // pt_users.id（拼车唯一用户表）
    phone: user.phone,
    email: user.email ?? null,
    userType: 1, // 1=普通用户
  };
}

/** 颁发会话：生成 access + refresh，refresh hash 存 Redis */
export async function issueAuthSession(user: UserRow, res: Response) {
  const payload = buildAuthPayload(user);
  const accessToken = generateToken(payload);
  const refreshToken = generateRefreshToken(payload);
  const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

  await redis.setex(`pt:refresh:${user.id}`, REFRESH_TTL_SECONDS, refreshTokenHash);

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
    // Path=/：让审计等所有 /api/* 请求都能带上 refresh_token 归属用户
    // （原 Path=/api/auth 只随 /api/auth/* 发送，会话闲置超 15 分钟后公开接口无法归属）
    path: "/",
  });
  // 清除旧版 Path=/api/auth 的历史 cookie，避免浏览器同时持两份 refresh_token、
  // 而刷新接口按"长 Path 优先"选到已失效的旧值导致循环 401
  res.clearCookie("refresh_token", { path: "/api/auth" });

  return { accessToken, refreshToken };
}

export async function revokeRefreshToken(userId: number): Promise<void> {
  await redis.del(`pt:refresh:${userId}`);
}

export async function matchesRefreshToken(userId: number, refreshToken: string): Promise<boolean> {
  const hash = await redis.get(`pt:refresh:${userId}`);
  if (!hash) return false;
  return bcrypt.compare(refreshToken, hash);
}

export function clearAuthCookies(res: Response) {
  res.clearCookie("auth_token", { path: "/" });
  res.clearCookie("refresh_token", { path: "/" });
  res.clearCookie("refresh_token", { path: "/api/auth" }); // 兼容历史 Path=/api/auth 残留
}

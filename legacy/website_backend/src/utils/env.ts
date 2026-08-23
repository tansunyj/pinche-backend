/**
 * 环境变量加载器（与 Next.js / Vite 的 dotenv 约定保持一致）
 *
 * 加载优先级（已存在的不会被后续文件覆盖）：
 *   .env.{NODE_ENV}.local   ← 本人本机的覆盖（最高优先级）
 *   .env.{NODE_ENV}         ← 当前环境的标准配置
 *   .env.local              ← 跨环境的本机覆盖
 *   .env                    ← 默认兜底
 *
 * NODE_ENV 默认 "development"。
 * 通过 `cross-env NODE_ENV=production` 在 npm scripts 中切换。
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs";

const NODE_ENV = process.env.NODE_ENV || "development";

const projectRoot = path.resolve(__dirname, "..", "..");

const candidates = [
  `.env.${NODE_ENV}.local`,
  `.env.${NODE_ENV}`,
  // 不要在 production 下加载 .env.local（与 Next.js 行为一致：避免线上意外读到本地覆盖）
  ...(NODE_ENV === "production" ? [] : [".env.local"]),
  ".env",
];

const loaded: string[] = [];
for (const name of candidates) {
  const filePath = path.join(projectRoot, name);
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath });
    loaded.push(name);
  }
}

console.log(`[env] NODE_ENV=${NODE_ENV} loaded=${loaded.join(", ") || "(none)"}`);

export const ENV = NODE_ENV;

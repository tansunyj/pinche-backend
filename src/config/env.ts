/**
 * 环境变量加载器（兼容 Next.js dotenv 约定）
 *
 * 加载优先级（已存在的不会被后续文件覆盖）：
 *   .env.{NODE_ENV}.local   ← 本人本机的覆盖（最高优先级）
 *   .env.{NODE_ENV}         ← 当前环境的标准配置
 *   .env.local              ← 跨环境的本机覆盖
 *   .env                    ← 默认兜底
 *
 * NODE_ENV 默认 "development"。
 * 必须放在所有其它 import 之前加载（见 src/index.ts 首行）。
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs";

const NODE_ENV = process.env.NODE_ENV || "development";

const projectRoot = path.resolve(__dirname, "..", "..");

const candidates = [
  `.env.${NODE_ENV}.local`,
  `.env.${NODE_ENV}`,
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

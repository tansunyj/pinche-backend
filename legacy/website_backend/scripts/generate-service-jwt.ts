/**
 * 生成服务间调用 JWT Token
 *
 * 用法：
 *   cd silievo-site/backend
 *   npx tsx scripts/generate-service-jwt.ts
 */

import dotenv from "dotenv";
import path from "path";
import jwt from "jsonwebtoken";

// 加载环境变量
dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET 未配置");
  process.exit(1);
}

// 生成服务 token（长期有效，用于服务间调用）
const payload = {
  userId: 0,
  email: "service@silievo.com",
  userType: 2,
  service: "silievo-site",
  aud: "relay-server",
  iss: "silievo-site",
};

const token = jwt.sign(payload, JWT_SECRET, {
  expiresIn: "1y", // 1年有效期
});

console.log("========================================");
console.log("      服务间 JWT Token 生成");
console.log("========================================\n");

console.log("Token:");
console.log(token);
console.log("\n");

// 解码显示内容
const decoded = jwt.decode(token);
console.log("Payload:");
console.log(JSON.stringify(decoded, null, 2));

console.log("\n========================================");
console.log("💡 使用方式:");
console.log("   将上面的 Token 复制到 .env.development 中的");
console.log("   RELAY_INTERNAL_JWT 变量");
console.log("========================================");

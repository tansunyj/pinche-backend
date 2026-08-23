/**
 * 生成 Relay Server 内部调用所需的 JWT
 *
 * 用法：
 *   npx tsx scripts/generate-relay-jwt.ts
 *
 * 输出：
 *   - JWT Token（用于 RELAY_INTERNAL_JWT 环境变量）
 *   - 解码后的 payload
 *
 * 说明：
 *   这个 JWT 用于 silievo-site 后端调用 relay server 的内部接口。
 *   它应该使用与 silievo-site 相同的 JWT_SECRET 签发。
 *   建议设置较长的有效期（如 1 年），因为它代表服务级别的调用。
 */

import jwt from "jsonwebtoken";

// 从环境变量读取 JWT_SECRET，或使用默认值（开发环境）
const JWT_SECRET = process.env.JWT_SECRET || "x9hPlHoa5XkARGcg1df8zDVCBbSc0bDVAapTDkUm3PUPq12VS27b99owqvH18O5x";

// 服务 token 的 payload
const payload = {
  userId: 0,  // 0 表示系统服务账号
  email: "service@silievo.com",
  userType: 2,  // 2 = 管理员
  service: "silievo-site",  // 标识调用方服务
};

// 签发配置：长期有效（1 年）
const options: jwt.SignOptions = {
  expiresIn: "365d",
  issuer: "silievo-site",
  audience: "relay-server",
};

const token = jwt.sign(payload, JWT_SECRET, options);

console.log("\n=== Relay Server Internal JWT 生成工具 ===\n");
console.log("JWT Secret:", JWT_SECRET.slice(0, 20) + "...");
console.log("\n生成的 JWT Token:");
console.log("=".repeat(60));
console.log(token);
console.log("=".repeat(60));

// 解码显示
const decoded = jwt.decode(token) as any;
console.log("\nToken 内容（解码后）:");
console.log(JSON.stringify(decoded, null, 2));

console.log("\n使用说明:");
console.log("1. 将上面的 JWT Token 复制到 silievo-site/backend/.env.development:");
console.log("   RELAY_INTERNAL_JWT=" + token.slice(0, 50) + "...");
console.log("\n2. 确保 relay server 的 JWT_SECRET 与此相同:");
console.log("   server/.env.development 中的 JWT_SECRET 应与上面使用的一致");
console.log("\n3. 重启 silievo-site backend 和 relay server:");
console.log("   cd silievo-site/backend && npm run dev");
console.log("   npm start  # 启动 relay server");
console.log("\n");
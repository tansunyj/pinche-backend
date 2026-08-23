/**
 * OSS 配置测试脚本
 *
 * 用法：
 *   cd silievo-site/backend
 *   npx tsx scripts/test-oss.ts
 *
 * 功能：
 *   1. 检查环境变量配置
 *   2. 测试 OSS 连接
 *   3. 上传测试图片
 *   4. 生成签名 URL
 *   5. 删除测试文件
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";

// 加载环境变量
dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

import { OssService } from "../src/services/storage/OssService";

// 测试图片（1x1 像素的透明 PNG）
const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function testOSS() {
  console.log("========== OSS 配置测试 ==========\n");

  // 1. 检查环境变量
  console.log("1. 环境变量检查:");
  const requiredEnv = [
    "OSS_REGION",
    "OSS_BUCKET",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
  ];

  const envStatus: Record<string, string> = {};
  for (const key of requiredEnv) {
    const value = process.env[key];
    const status = value ? "✅ 已配置" : "❌ 未配置";
    const displayValue = value
      ? key.includes("SECRET")
        ? `${value.slice(0, 6)}...${value.slice(-4)}`
        : value
      : "N/A";
    envStatus[key] = displayValue;
    console.log(`   ${key}: ${status} (${displayValue})`);
  }

  const allConfigured = requiredEnv.every((key) => process.env[key]);
  if (!allConfigured) {
    console.error("\n❌ 部分环境变量未配置，请检查 .env.development 文件");
    process.exit(1);
  }

  // 2. 检查 dry-run 模式
  console.log("\n2. 运行模式检查:");
  const isDryRun = OssService.isDryRun();
  if (isDryRun) {
    console.log("   ⚠️ 当前处于 DRY-RUN 模式（本地模拟）");
    console.log("   原因：STORAGE_DRY_RUN=true 或 OSS 凭证未配置");
  } else {
    console.log("   ✅ 生产模式：将连接到阿里云 OSS");
    console.log(`   Bucket: ${process.env.OSS_BUCKET}`);
    console.log(`   Region: ${process.env.OSS_REGION}`);
  }

  // 3. 测试上传
  console.log("\n3. 测试上传文件:");
  try {
    const testBuffer = Buffer.from(TEST_IMAGE_BASE64, "base64");
    const ossKey = OssService.buildKey({
      userId: 0,
      kind: "upload",
      mime: "image/png",
    });

    console.log(`   生成的 OSS Key: ${ossKey}`);
    console.log(`   文件大小: ${testBuffer.length} bytes`);

    const result = await OssService.putObject({
      ossKey,
      body: testBuffer,
      mime: "image/png",
    });

    console.log(`   ✅ 上传成功: ${result.ossKey}`);
    console.log(`   实际大小: ${result.size} bytes`);

    // 4. 测试生成签名 URL
    console.log("\n4. 测试生成签名 URL:");
    const signedUrl = await OssService.getSignedUrl(ossKey, 3600);
    console.log(`   ✅ 签名 URL 生成成功:`);
    console.log(`   ${signedUrl.slice(0, 100)}...`);

    // 5. 测试删除
    console.log("\n5. 测试删除文件:");
    await OssService.deleteObject(ossKey);
    console.log(`   ✅ 删除成功: ${ossKey}`);

    // 6. 总结
    console.log("\n========== 测试结果 ==========");
    if (isDryRun) {
      console.log("✅ DRY-RUN 模式测试通过！");
      console.log("   文件存储在本地: ./tmp/oss-mock/");
      console.log("\n💡 要切换到真实 OSS，请确保:");
      console.log("   1. STORAGE_DRY_RUN 未设置或为 false");
      console.log("   2. OSS_ACCESS_KEY_ID 和 OSS_ACCESS_KEY_SECRET 正确配置");
    } else {
      console.log("✅ OSS 生产模式测试通过！");
      console.log("   已成功连接到阿里云 OSS");
      console.log(`   Bucket: ${process.env.OSS_BUCKET}`);
    }
  } catch (error: any) {
    console.error(`\n❌ 测试失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行测试
testOSS().catch((err) => {
  console.error("测试异常:", err);
  process.exit(1);
});

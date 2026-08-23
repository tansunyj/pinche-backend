/**
 * 上传本地图片到 OSS
 *
 * 用法：
 *   cd silievo-site/backend
 *   npx tsx scripts/upload-image.ts "图片路径"
 *
 * 示例：
 *   npx tsx scripts/upload-image.ts "F:/工作/合作项目/AI agent进化/silievo中转平台/image-1.png"
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";

// 加载环境变量
dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

import { OssService } from "../src/services/storage/OssService";

// 从命令行参数获取图片路径
const imagePath = process.argv[2];

async function uploadImage() {
  if (!imagePath) {
    console.error("❌ 请提供图片路径");
    console.error("用法: npx tsx scripts/upload-image.ts \"图片路径\"");
    process.exit(1);
  }

  console.log("========== 上传图片到 OSS ==========\n");
  console.log(`本地图片路径: ${imagePath}`);

  try {
    // 读取图片文件
    const imageBuffer = await fs.readFile(imagePath);
    console.log(`文件大小: ${(imageBuffer.length / 1024).toFixed(2)} KB`);

    // 获取文件名和扩展名
    const fileName = path.basename(imagePath);
    const ext = path.extname(fileName).toLowerCase().slice(1);

    // 确定 MIME 类型
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    };
    const mime = mimeMap[ext] || "image/png";
    console.log(`MIME 类型: ${mime}`);

    // 生成 OSS Key
    const ossKey = OssService.buildKey({
      userId: 0, // 测试用户
      kind: "upload",
      mime,
    });
    console.log(`\n生成的 OSS Key: ${ossKey}`);

    // 上传到 OSS
    console.log("\n正在上传...");
    const result = await OssService.putObject({
      ossKey,
      body: imageBuffer,
      mime,
    });

    console.log(`✅ 上传成功!`);
    console.log(`   OSS Key: ${result.ossKey}`);
    console.log(`   文件大小: ${(result.size / 1024).toFixed(2)} KB`);

    // 生成签名 URL（1小时有效）
    const signedUrl = await OssService.getSignedUrl(ossKey, 3600);
    console.log(`\n✅ 签名 URL 生成成功:`);
    console.log(`   ${signedUrl}`);

    console.log("\n========== 上传完成 ==========");
    console.log("图片已成功上传到阿里云 OSS!");
    console.log(`\n文件路径: ${ossKey}`);
    console.log(`可以通过签名 URL 访问，有效期 1 小时。`);
  } catch (error: any) {
    console.error(`\n❌ 上传失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行上传
uploadImage().catch((err) => {
  console.error("上传异常:", err);
  process.exit(1);
});

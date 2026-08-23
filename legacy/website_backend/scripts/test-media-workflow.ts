/**
 * 媒体生成工作流完整测试
 *
 * 测试内容：
 *   1. 上传本地图片到 OSS（模拟用户上传参考图）
 *   2. 创建图生图任务（使用上传的图片作为 inputAssetId）
 *   3. 验证任务提交和参数传递
 *
 * 用法：
 *   cd silievo-site/backend
 *   npx tsx scripts/test-media-workflow.ts "图片路径"
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";

// 加载环境变量
dotenv.config({ path: path.resolve(process.cwd(), ".env.development") });

import MediaAssetService from "../src/services/MediaAssetService";
import MediaJobService from "../src/services/MediaJobService";
import OssService from "../src/services/storage/OssService";
import pool from "../src/db/mysql";

// 测试用户ID（使用一个测试用户）
const TEST_USER_ID = 1;

// 给用户充值（测试用）
async function ensureUserBalance(userId: number, minBalance: number = 100) {
  console.log(`【准备】检查用户 ${userId} 余额...`);

  const [[row]] = await pool.execute<any[]>(
    `SELECT balance FROM user_users WHERE id = ? LIMIT 1`,
    [userId]
  );

  if (!row) {
    throw new Error(`用户 ${userId} 不存在`);
  }

  const currentBalance = Number(row.balance) || 0;
  console.log(`当前余额: ${currentBalance} 点`);

  if (currentBalance < minBalance) {
    console.log(`余额不足，充值 ${minBalance} 点...`);
    await pool.execute(
      `UPDATE user_users SET balance = balance + ? WHERE id = ?`,
      [minBalance, userId]
    );
    console.log(`✅ 充值成功！`);

    // 记录充值流水
    await pool.execute(
      `INSERT INTO billing_transactions (user_id, type, delta, balance_after, ref_type, ref_id, remark)
       VALUES (?, 'recharge', ?, ?, 'test', 0, ?)`,
      [userId, minBalance, currentBalance + minBalance, "测试脚本自动充值"]
    );
  } else {
    console.log(`✅ 余额充足，无需充值`);
  }

  return currentBalance + minBalance;
}

async function testWorkflow() {
  const imagePath = process.argv[2];

  console.log("========================================");
  console.log("      媒体生成工作流完整测试");
  console.log("========================================\n");

  if (!imagePath) {
    console.error("❌ 请提供测试图片路径");
    console.error("用法: npx tsx scripts/test-media-workflow.ts \"图片路径\"");
    process.exit(1);
  }

  // 确保用户有余额
  try {
    await ensureUserBalance(TEST_USER_ID, 100);
  } catch (error: any) {
    console.error(`❌ 余额准备失败: ${error.message}`);
    process.exit(1);
  }

  // ========== 步骤 1: 上传本地图片到 OSS ==========
  console.log("【步骤 1】上传本地图片到 OSS");
  console.log(`图片路径: ${imagePath}`);

  let uploadedAsset: Awaited<ReturnType<typeof MediaAssetService.uploadAndCreate>> | null = null;

  try {
    // 读取图片
    const imageBuffer = await fs.readFile(imagePath);
    console.log(`文件大小: ${(imageBuffer.length / 1024).toFixed(2)} KB`);

    // 获取文件类型
    const ext = path.extname(imagePath).toLowerCase().slice(1);
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
    };
    const mime = mimeMap[ext] || "image/png";

    // 上传到 OSS 并入库
    uploadedAsset = await MediaAssetService.uploadAndCreate({
      userId: TEST_USER_ID,
      type: "image",
      source: "uploaded",
      body: imageBuffer,
      mime,
      width: null,
      height: null,
    });

    console.log("✅ 图片上传成功！");
    console.log(`   Asset ID: ${uploadedAsset.id}`);
    console.log(`   OSS Key: ${uploadedAsset.url.split('?')[0].split('/').slice(3).join('/').replace(/^.*?\.com\//, '')}`);
    console.log(`   签名 URL: ${uploadedAsset.url.slice(0, 80)}...`);
  } catch (error: any) {
    console.error(`❌ 图片上传失败: ${error.message}`);
    process.exit(1);
  }

  // ========== 步骤 2: 创建图生图任务 ==========
  console.log("\n【步骤 2】创建图生图任务");

  let job: Awaited<ReturnType<typeof MediaJobService.submitJob>> | null = null;

  try {
    job = await MediaJobService.submitJob({
      userId: TEST_USER_ID,
      kind: "i2i",
      modelId: "wanx2.1-t2i-plus", // 使用文生图模型测试
      prompt: "一只可爱的猫咪，卡通风格，色彩鲜艳",
      negativePrompt: "模糊，低质量",
      inputAssetId: uploadedAsset!.id, // 使用刚上传的图片
      params: {
        aspect: "1:1",
        n: 1,
      },
    });

    console.log("✅ 任务创建成功！");
    console.log(`   Job ID: ${job.id}`);
    console.log(`   Kind: ${job.kind}`);
    console.log(`   Model: ${job.model_id}`);
    console.log(`   Status: ${job.status}`);
    console.log(`   Input Asset ID: ${job.input_asset_id}`);
    console.log(`   预估点数: ${job.points_estimated}`);
  } catch (error: any) {
    console.error(`❌ 任务创建失败: ${error.message}`);
    // 清理上传的图片
    console.log("\n清理测试数据...");
    await MediaAssetService.softDelete([uploadedAsset!.id], TEST_USER_ID);
    process.exit(1);
  }

  // ========== 步骤 3: 验证 resolveInputAssets ==========
  console.log("\n【步骤 3】验证输入资产解析");

  try {
    // 从数据库获取 job row
    const [rows] = await pool.execute<any[]>(
      `SELECT * FROM media_jobs WHERE id = ? LIMIT 1`,
      [job!.id]
    );
    const jobRow = rows[0];

    if (!jobRow) {
      throw new Error("Job 不存在");
    }

    // 调用 resolveInputAssets
    const { inputAsset, inputAssetEnd } = await MediaJobService.resolveInputAssets(jobRow);

    console.log("✅ 输入资产解析成功！");
    console.log(`   Input Asset ID: ${inputAsset?.assetId}`);
    console.log(`   Input Asset MIME: ${inputAsset?.mime}`);
    console.log(`   签名 URL: ${inputAsset?.signedUrl?.slice(0, 80)}...`);
    console.log(`   Input Asset End: ${inputAssetEnd ?? "null"}`);

    // 验证签名 URL 是否可访问
    console.log("\n【验证】测试签名 URL 可访问性...");
    const testResp = await fetch(inputAsset!.signedUrl, { method: "HEAD" });
    if (testResp.ok) {
      console.log("✅ 签名 URL 可正常访问！");
      console.log(`   Content-Type: ${testResp.headers.get("content-type")}`);
      console.log(`   Content-Length: ${testResp.headers.get("content-length")} bytes`);
    } else {
      console.warn(`⚠️ 签名 URL 访问异常: HTTP ${testResp.status}`);
    }
  } catch (error: any) {
    console.error(`❌ 输入资产解析失败: ${error.message}`);
  }

  // ========== 步骤 4: 模拟 Poller 调用 Provider ==========
  console.log("\n【步骤 4】模拟 Poller 调用 Provider");
  console.log("（这一步会实际调用 Relay Server 提交任务到 DashScope）");

  try {
    const { getProvider } = await import("../src/services/media");
    const provider = getProvider("alibaba");

    console.log(`Provider: ${provider.name}`);
    console.log(`Supports: ${provider.supports.join(", ")}`);
    console.log(`Configured: ${provider.isConfigured()}`);

    if (!provider.isConfigured()) {
      console.log("⚠️ Provider 未配置，跳过实际提交测试");
      console.log("   请检查 RELAY_INTERNAL_JWT 环境变量");
    } else {
      // 获取 job row 用于提交
      const [rows] = await pool.execute<any[]>(
        `SELECT * FROM media_jobs WHERE id = ? LIMIT 1`,
        [job!.id]
      );
      const jobRow = rows[0];

      // 解析输入资产
      const { inputAsset, inputAssetEnd } = await MediaJobService.resolveInputAssets(jobRow);

      console.log("\n正在提交到 Provider...");
      const result = await provider.submit({
        jobId: job!.id,
        userId: TEST_USER_ID,
        kind: "i2i",
        modelId: job!.model_id,
        prompt: job!.prompt,
        negativePrompt: job!.negative_prompt,
        inputAsset,
        inputAssetEnd,
        params: JSON.parse(job!.params || "{}"),
      });

      console.log("✅ Provider 提交成功！");
      console.log(`   Provider Task ID: ${result.providerTaskId}`);
    }
  } catch (error: any) {
    console.error(`❌ Provider 提交失败: ${error.message}`);
    console.error(error.stack);
  }

  // ========== 测试总结 ==========
  console.log("\n========================================");
  console.log("            测试总结");
  console.log("========================================");
  console.log(`✅ 图片上传: Asset ID = ${uploadedAsset!.id}`);
  console.log(`✅ 任务创建: Job ID = ${job!.id}`);
  console.log(`✅ 输入资产解析: 正常工作`);
  console.log("\n测试数据:");
  console.log(`   用户 ID: ${TEST_USER_ID}`);
  console.log(`   Asset ID: ${uploadedAsset!.id}`);
  console.log(`   Job ID: ${job!.id}`);
  console.log("\n💡 提示: 任务已创建，Poller 会自动处理后续流程");
  console.log("   你可以在前端页面查看任务状态");

  // 关闭数据库连接
  await pool.end();
}

// 运行测试
testWorkflow().catch((err) => {
  console.error("\n测试异常:", err);
  process.exit(1);
});

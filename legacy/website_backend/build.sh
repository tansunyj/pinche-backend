#!/bin/bash
# 生产构建脚本 - 跳过类型检查

echo "🔨 构建生产版本（跳过类型检查）..."

# 使用 tsc 但跳过类型检查
npx tsc --noEmitOnError false

# 或者使用 babel 编译（更快）
# npx babel src --out-dir dist --extensions ".ts,.tsx"

echo "✅ 构建完成"

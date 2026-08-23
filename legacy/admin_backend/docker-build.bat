@echo off
rem ============================================================
rem  Silievo Admin Backend - 本地构建镜像（不推任何镜像仓库）
rem  用法: docker-build.bat [TAG]    默认 TAG=local
rem        local 与 docker-compose.yml 的 image 保持一致。
rem        本机 Windows 上构建后用于本地测试（bridge 网络 + 端口映射）；
rem        服务器（Linux）直接用 docker-build.sh + docker compose up -d。
rem ============================================================
setlocal

set "TAG=%~1"
if "%TAG%"=="" set "TAG=local"
set "IMAGE=silievo-admin-backend:%TAG%"

echo.
echo [1/2] 构建镜像: %IMAGE%
docker build -t "%IMAGE%" -f Dockerfile .
if errorlevel 1 ( echo [错误] 构建失败 & exit /b 1 )

echo.
echo [2/2] 构建完成！
echo   启动: docker compose up -d
endlocal

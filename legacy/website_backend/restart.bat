@echo off
chcp 65001 >nul 2>&1

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "SERVICE_NAME=silievo-website-backend"
set "PORT=13001"
set "NEED_BUILD=true"
set "ENTRY=dist\index.js"

cd /d "%SCRIPT_DIR%"

set "COMMAND=%~1"
if "%COMMAND%"=="" set "COMMAND=restart"

echo ==========================================
echo Service: %SERVICE_NAME%
echo Port: %PORT%
echo Need Build: %NEED_BUILD%
echo Command: %COMMAND%
echo ==========================================
echo.

if "%COMMAND%"=="install" (
    echo [INFO] Installing dependencies...
    if not exist "package.json" (
        echo [ERROR] package.json not found
        exit /b 1
    )
    npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies
        exit /b 1
    )
    echo [SUCCESS] Dependencies installed
    goto end
)

if "%COMMAND%"=="build" (
    echo [INFO] Building project...
    npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed
        exit /b 1
    )
    echo [SUCCESS] Build complete
    goto end
)

if "%COMMAND%"=="stop" (
    echo [INFO] Stopping service...
    echo [INFO] Finding processes on port %PORT%...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING" 2^>nul') do (
        echo [INFO] Found process PID: %%a
        taskkill /F /PID %%a >nul 2>&1
        if not errorlevel 1 (
            echo [SUCCESS] Process %%a terminated
        )
    )
    echo [SUCCESS] Service stopped
    goto end
)

if "%COMMAND%"=="start" (
    echo [INFO] Starting service...
    if exist ".env.production" (
        echo [INFO] Loading environment: .env.production
    ) else if exist ".env" (
        echo [INFO] Loading environment: .env
    )
    if not exist "%ENTRY%" (
        echo [ERROR] Entry file not found: %ENTRY%
        echo [ERROR] Please run 'restart.bat build' first
        exit /b 1
    )
    echo [INFO] Entry: %ENTRY%
    echo [INFO] Starting: node %ENTRY%
    echo [INFO] Press Ctrl+C to stop
    echo.
    node %ENTRY%
    goto end
)

if "%COMMAND%"=="restart" (
    echo [INFO] === Full Deploy Start ===
    echo.

    echo [INFO] Step 1/4: Installing dependencies...
    if not exist "package.json" (
        echo [ERROR] package.json not found
        exit /b 1
    )
    npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies
        exit /b 1
    )
    echo [SUCCESS] Dependencies installed
    echo.

    echo [INFO] Step 2/4: Building project...
    npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed
        exit /b 1
    )
    echo [SUCCESS] Build complete
    echo.

    echo [INFO] Step 3/4: Stopping old service...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING" 2^>nul') do (
        echo [INFO] Found process PID: %%a
        taskkill /F /PID %%a >nul 2>&1
        echo [SUCCESS] Process %%a terminated
    )
    echo [SUCCESS] Old service stopped
    echo.

    echo [INFO] Step 4/4: Starting new service...
    if exist ".env.production" (
        echo [INFO] Loading environment: .env.production
    ) else if exist ".env" (
        echo [INFO] Loading environment: .env
    )
    echo [INFO] Entry: %ENTRY%
    echo [INFO] Starting: node %ENTRY%
    echo [INFO] Press Ctrl+C to stop
    echo.
    node %ENTRY%
    goto end
)

if "%COMMAND%"=="status" (
    echo [INFO] Service status:
    tasklist /FI "IMAGENAME eq node.exe" /FO TABLE 2>nul
    goto end
)

if "%COMMAND%"=="logs" (
    echo [INFO] Logs are displayed in console window
    goto end
)

echo Usage: restart.bat [command]
echo.
echo Commands:
echo   install    Install dependencies
echo   build      Build project
echo   start      Start service
echo   stop       Stop service
echo   restart    Full deploy (default)
echo   status     Show status
echo   logs       Show logs
echo.
pause

:end

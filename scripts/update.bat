@echo off
:: Run this whenever you want to deploy a new version from GitHub
:: Pull latest code, rebuild frontend, restart service

set APP_DIR=%~dp0..
set SERVICE_NAME=CardosoCigarettes

echo === Cardoso Update Script ===
cd /d "%APP_DIR%"

echo [1/5] Stopping service...
nssm stop %SERVICE_NAME%
timeout /t 3 /nobreak >nul

echo [2/5] Pulling latest code from GitHub...
git pull origin main
if errorlevel 1 (
    echo Git pull failed. Starting service back up...
    nssm start %SERVICE_NAME%
    pause
    exit /b 1
)

echo [3/5] Installing dependencies...
call npm install --production=false
if errorlevel 1 (
    echo npm install failed. Starting service back up...
    nssm start %SERVICE_NAME%
    pause
    exit /b 1
)

echo [4/5] Building frontend...
call npm run build
if errorlevel 1 (
    echo Build failed. Starting service back up...
    nssm start %SERVICE_NAME%
    pause
    exit /b 1
)

echo [5/5] Starting service...
nssm start %SERVICE_NAME%
timeout /t 3 /nobreak >nul

nssm status %SERVICE_NAME%
echo.
echo Update complete. App running at: http://localhost:3001
pause

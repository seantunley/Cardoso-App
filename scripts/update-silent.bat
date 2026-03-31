@echo off
:: Silent auto-update script for Cardoso Windows Service
:: Triggered by the app's hourly update check or by admin via UI
:: Logs to: C:\Cardoso Customer App\logs\update.log

set APP_DIR=C:\Cardoso Customer App
set SERVICE_NAME=CardosoCigarettes
set LOG_FILE=%APP_DIR%\logs\update.log

if not exist "%APP_DIR%\logs" mkdir "%APP_DIR%\logs"

echo [%date% %time%] === Cardoso Auto-Update Started === >> "%LOG_FILE%"

:: Stop service
echo [%date% %time%] Stopping service... >> "%LOG_FILE%"
nssm stop %SERVICE_NAME% >> "%LOG_FILE%" 2>&1
timeout /t 5 /nobreak >nul

:: Git pull
echo [%date% %time%] Pulling latest from GitHub... >> "%LOG_FILE%"
cd /d "%APP_DIR%"
git pull origin main >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [%date% %time%] ERROR: git pull failed. Restarting service. >> "%LOG_FILE%"
    nssm start %SERVICE_NAME% >> "%LOG_FILE%" 2>&1
    exit /b 1
)

:: npm install
echo [%date% %time%] Installing dependencies... >> "%LOG_FILE%"
call npm install --production=false >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [%date% %time%] ERROR: npm install failed. Restarting service. >> "%LOG_FILE%"
    nssm start %SERVICE_NAME% >> "%LOG_FILE%" 2>&1
    exit /b 1
)

:: Build frontend
echo [%date% %time%] Building frontend... >> "%LOG_FILE%"
call npm run build >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [%date% %time%] ERROR: build failed. Restarting service. >> "%LOG_FILE%"
    nssm start %SERVICE_NAME% >> "%LOG_FILE%" 2>&1
    exit /b 1
)

:: Start service
echo [%date% %time%] Starting service... >> "%LOG_FILE%"
nssm start %SERVICE_NAME% >> "%LOG_FILE%" 2>&1
timeout /t 5 /nobreak >nul

echo [%date% %time%] === Update Complete === >> "%LOG_FILE%"
exit /b 0

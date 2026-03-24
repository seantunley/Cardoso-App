@echo off
:: Run this once to install Cardoso as a Windows service
:: Requires: NSSM (https://nssm.cc) in PATH or same folder
:: App must be cloned/extracted to: C:\Cardoso Customer App

set APP_DIR=C:\Cardoso Customer App
set SERVICE_NAME=CardosoCigarettes
set NODE_PATH=node

:: Build the frontend first
echo Building frontend...
cd /d "%APP_DIR%"
call npm run build
if errorlevel 1 (
    echo Build failed. Aborting.
    pause
    exit /b 1
)

:: Install the service via NSSM
echo Installing Windows service...
nssm install %SERVICE_NAME% "%NODE_PATH%" "server.js"
nssm set %SERVICE_NAME% AppDirectory "%APP_DIR%"
nssm set %SERVICE_NAME% AppEnvironmentExtra "NODE_ENV=production"
nssm set %SERVICE_NAME% DisplayName "Cardoso Cigarettes Customer Manager"
nssm set %SERVICE_NAME% Description "Cardoso Customer Manager backend + frontend"
nssm set %SERVICE_NAME% Start SERVICE_AUTO_START
nssm set %SERVICE_NAME% AppStdout "%APP_DIR%\logs\service.log"
nssm set %SERVICE_NAME% AppStderr "%APP_DIR%\logs\service-error.log"
nssm set %SERVICE_NAME% AppRotateFiles 1
nssm set %SERVICE_NAME% AppRotateSeconds 86400

:: Create logs folder
if not exist "%APP_DIR%\logs" mkdir "%APP_DIR%\logs"

:: Start the service
nssm start %SERVICE_NAME%

echo.
echo Service "%SERVICE_NAME%" installed and started.
echo App running at: http://localhost:3001
pause

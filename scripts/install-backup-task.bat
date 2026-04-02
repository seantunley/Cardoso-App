@echo off
:: install-backup-task.bat
:: Registers a daily Windows Task Scheduler job to back up the Cardoso database.
:: Run as Administrator.

setlocal

set APP_DIR=C:\Cardoso Customer App
set TASK_NAME=CardosoBackup
set SCRIPT=%APP_DIR%\scripts\backup.ps1

:: Default: run daily at 02:00
set BACKUP_TIME=02:00

echo Installing Cardoso backup scheduled task...

:: Remove existing task if present
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: Create new task
schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "powershell.exe -NonInteractive -ExecutionPolicy Bypass -File \"%SCRIPT%\"" ^
  /sc DAILY ^
  /st %BACKUP_TIME% ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% equ 0 (
    echo.
    echo [OK] Backup task registered successfully.
    echo      Schedule: Daily at %BACKUP_TIME%
    echo      Script:   %SCRIPT%
    echo      Backups:  %APP_DIR%\database\backups\
    echo      Log:      %APP_DIR%\logs\backup.log
    echo.
    echo To run a backup immediately:
    echo   schtasks /run /tn "%TASK_NAME%"
) else (
    echo.
    echo [ERROR] Failed to register task. Make sure you are running as Administrator.
)

endlocal
pause

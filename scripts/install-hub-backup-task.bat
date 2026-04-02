@echo off
:: install-hub-backup-task.bat
:: Registers a daily Windows Task Scheduler job on the Hub (Head Office) machine
:: to pull database backups from all registered sites.
:: Run as Administrator.

setlocal

set APP_DIR=C:\Cardoso Customer App
set TASK_NAME=CardosoHubBackup
set SCRIPT=%APP_DIR%\scripts\hub-pull-backups.ps1

:: Default: run daily at 03:00 (1 hour after site local backups at 02:00)
set BACKUP_TIME=03:00

echo Installing Cardoso Hub backup scheduled task...

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
    echo [OK] Hub backup task registered successfully.
    echo      Schedule: Daily at %BACKUP_TIME%
    echo      Script:   %SCRIPT%
    echo      Backups:  %APP_DIR%\database\hub-backups\^<site_id^>\
    echo      Log:      %APP_DIR%\logs\hub-backup.log
    echo.
    echo To run immediately:
    echo   schtasks /run /tn "%TASK_NAME%"
) else (
    echo.
    echo [ERROR] Failed to register task. Make sure you are running as Administrator.
)

endlocal
pause

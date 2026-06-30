; Cardoso Customer Manager - Windows Installer
; Requires: NSIS 3.x, Node.js bundled in build/node/, NSSM in build/nssm/
; Build via: makensis windows/installer.nsi

!define APP_NAME "Cardoso Customer Manager"
!define SERVICE_NAME "CardosoCigarettes"
!define APP_DIR "C:\Cardoso Customer App"
!define OUT_FILE "CardosoSetup.exe"
!define PUBLISHER "Cardoso"
!define UNINSTALLER "Uninstall.exe"

; Patched in by .github/workflows/build-windows.yml — leave the placeholder
; values alone. The installer writes these to disk so the in-app delta updater
; can decide whether the next release ships only the app zip (lock_hash match)
; or the full EXE (lock_hash changed → dependencies were updated).
!define LOCK_HASH "BUILD_LOCK_HASH_PLACEHOLDER"
!define INSTALLED_VERSION "BUILD_VERSION_PLACEHOLDER"

Name "${APP_NAME}"
OutFile "..\${OUT_FILE}"
InstallDir "${APP_DIR}"
RequestExecutionLevel admin
SetCompressor lzma

; Version info
VIProductVersion "2026.1.2.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} Installer"
VIAddVersionKey "FileVersion" "2026.1.2"

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom ConfigPage ConfigPageLeave
; (Config page is skipped automatically in silent mode)
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; Config page variables
Var Dialog
Var PortLabel
Var PortField
Var PortValue
Var SiteNameLabel
Var SiteNameField
Var SiteNameValue

Function ConfigPage
  !insertmacro MUI_HEADER_TEXT "Service Configuration" "Set the port and site name for this installation."
  nsDialogs::Create 1018
  Pop $Dialog

  ${NSD_CreateLabel} 0 20u 100% 12u "Port number (default: 3001):"
  Pop $PortLabel
  ${NSD_CreateText} 0 34u 60u 12u "3001"
  Pop $PortField

  ${NSD_CreateLabel} 0 60u 100% 12u "Site name (e.g. Ermelo, Johannesburg):"
  Pop $SiteNameLabel
  ${NSD_CreateText} 0 74u 150u 12u "Site"
  Pop $SiteNameField

  nsDialogs::Show
FunctionEnd

Function ConfigPageLeave
  ${NSD_GetText} $PortField $PortValue
  ${NSD_GetText} $SiteNameField $SiteNameValue
FunctionEnd

Section "Install" SecInstall
  ; Ensure silent-mode installs get sane defaults (custom pages are skipped with /S)
  ${If} "$PortValue" == ""
    StrCpy $PortValue "3001"
  ${EndIf}
  ${If} "$SiteNameValue" == ""
    StrCpy $SiteNameValue "Cardoso Site"
  ${EndIf}

  ; Stop the service so files can be replaced. We deliberately do NOT
  ; `nssm remove` here — the previous flow removed the service before
  ; extracting files, so any failure between (file lock, AV, NSIS timeout,
  ; nssm install exiting non-zero) left the service permanently gone with
  ; no recovery. Keep the service registered; reconfigure it after the
  ; new files land so a mid-extract failure leaves the old service intact.
  ExecWait '"$INSTDIR\nssm\nssm.exe" stop ${SERVICE_NAME}' $0
  Sleep 3000

  SetOutPath "$INSTDIR"

  ; Copy the pre-staged app bundle — server.js, dist, src, scripts, vendor,
  ; package files AND node_modules (native binaries pre-compiled on the CI
  ; runner) — directly with File /r.
  ;
  ; This is the long-proven mechanism. The tar-archive "streamline" (one-pass
  ; extract) was withdrawn: it depended on a usable tar.exe being present on the
  ; target, and that assumption failed on real machines in multiple ways (a
  ; 32-bit installer's $SYSDIR redirects to a SysWOW64 with no tar; IfFileExists
  ; doesn't resolve the Sysnative path; a bare "tar.exe" on PATH can be a
  ; non-bsdtar that fails on C:\ paths). File /r has NO such dependency — it just
  ; writes the files. The CI dev-dependency prune keeps node_modules ~half-size,
  ; so this is still faster than before that change, without the fragility.
  File /r ".\build\app\*"

  ; Copy bundled Node.js runtime
  SetOutPath "$INSTDIR\node"
  File /r ".\build\node\*"

  ; Copy NSSM
  SetOutPath "$INSTDIR\nssm"
  File ".\build\nssm\nssm.exe"


  ; Create logs dir
  CreateDirectory "$INSTDIR\logs"
  CreateDirectory "$INSTDIR\database"

  ; Marker files for the in-app delta updater. Future versions read these to
  ; decide whether to download just the small app zip or the full installer.
  Delete "$INSTDIR\.lock-hash"
  FileOpen $0 "$INSTDIR\.lock-hash" w
  FileWrite $0 "${LOCK_HASH}"
  FileClose $0
  Delete "$INSTDIR\.installed-version"
  FileOpen $0 "$INSTDIR\.installed-version" w
  FileWrite $0 "${INSTALLED_VERSION}"
  FileClose $0

  ; Write .env only if it does not already exist (preserve existing config on upgrade)
  IfFileExists "$INSTDIR\.env" env_exists env_missing
  env_missing:
    FileOpen $0 "$INSTDIR\.env" w
    FileWrite $0 "NODE_ENV=production$\r$\n"
    FileWrite $0 "PORT=$PortValue$\r$\n"
    FileWrite $0 "SITE_NAME=$SiteNameValue$\r$\n"
    FileWrite $0 "DB_PATH=./database/cardoso.db$\r$\n"
    FileWrite $0 "SESSION_SECRET=CHANGE_ME_RUN_SETUP$\r$\n"
    FileWrite $0 "ENCRYPTION_KEY=$\r$\n"
    ; Off-site backups (Kopia). kopia.exe is bundled at $INSTDIR\kopia\kopia.exe.
    ; Disabled by default - to activate, set KOPIA_ENABLED=true + the hub values,
    ; then run scripts\kopia-agent-setup.ps1 once (see docs/kopia-backups.md).
    FileWrite $0 "$\r$\n"
    FileWrite $0 "# --- Off-site backups (Kopia) - see docs/kopia-backups.md ---$\r$\n"
    FileWrite $0 "KOPIA_ENABLED=false$\r$\n"
    FileWrite $0 "KOPIA_EXE=$INSTDIR\kopia\kopia.exe$\r$\n"
    FileWrite $0 "KOPIA_HUB_URL=$\r$\n"
    FileWrite $0 "KOPIA_CERT_FINGERPRINT=$\r$\n"
    FileWrite $0 "KOPIA_SITE_SLUG=$\r$\n"
    FileWrite $0 "KOPIA_SERVER_PASSWORD=$\r$\n"
    FileClose $0
  env_exists:

  ; Install OR reconfigure the Windows service via NSSM.
  ; `nssm install` exits non-zero if the service already exists; that's fine —
  ; we suppress the failure and let the subsequent `set` calls bring an
  ; existing service back into a known-good configuration. On a fresh box
  ; the install line creates the service; the `set` lines are then redundant
  ; but harmless. This double-coverage is what keeps an upgrade safe even if
  ; the service had drift from a prior partial install.
  ExecWait '"$INSTDIR\nssm\nssm.exe" install ${SERVICE_NAME} "$INSTDIR\node\node.exe" "-r dotenv/config server.js"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} Application "$INSTDIR\node\node.exe"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppParameters "-r dotenv/config server.js"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppDirectory "$INSTDIR"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppEnvironmentExtra "NODE_ENV=production"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} DisplayName "${APP_NAME}"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} Description "Cardoso Customer Manager - runs as background service"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} Start SERVICE_AUTO_START' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppStdout "$INSTDIR\logs\service.log"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppStderr "$INSTDIR\logs\service-error.log"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppRotateFiles 1' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppRotateSeconds 86400' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" start ${SERVICE_NAME}' $0

  ; Register daily backup scheduled task (runs at 02:00, overwrites if exists)
  ExecWait '$SYSDIR\schtasks.exe /delete /tn "CardosoBackup" /f' $0
  ExecWait '$SYSDIR\schtasks.exe /create /tn "CardosoBackup" /tr "powershell.exe -NonInteractive -ExecutionPolicy Bypass -File \"$INSTDIR\scripts\backup.ps1\"" /sc DAILY /st 02:00 /rl HIGHEST /f' $0

  ; Create desktop shortcut to open app in browser
  CreateShortcut "$DESKTOP\Cardoso.lnk" "http://localhost:$PortValue" "" "" 0

  ; Write uninstaller
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  ; Add to Add/Remove Programs
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" \
    "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" \
    "UninstallString" "$INSTDIR\${UNINSTALLER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" \
    "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}" \
    "DisplayVersion" "2026.1.2"

  ; Only show message box in interactive mode
  IfSilent done_msg
  MessageBox MB_OK "Cardoso is installed and running.$\n$\nOpen: http://localhost:$PortValue$\n$\nIMPORTANT: Edit $INSTDIR\.env and set SESSION_SECRET and ENCRYPTION_KEY, then restart the service."
  done_msg:
SectionEnd

Section "Uninstall"
  ExecWait '"$INSTDIR\nssm\nssm.exe" stop ${SERVICE_NAME}' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" remove ${SERVICE_NAME} confirm' $0
  ExecWait '$SYSDIR\schtasks.exe /delete /tn "CardosoBackup" /f' $0
  ; Off-site agent task (created by scripts\kopia-agent-setup.ps1 if activated) —
  ; best-effort removal; harmless if it was never registered.
  ExecWait '$SYSDIR\schtasks.exe /delete /tn "CardosoKopiaAgent" /f' $0

  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\nssm"
  RMDir /r "$INSTDIR\kopia"
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\scripts"
  Delete "$INSTDIR\server.js"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir /r "$INSTDIR\node_modules"
  Delete "$DESKTOP\Cardoso.lnk"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}"

  MessageBox MB_OK "Cardoso has been uninstalled.$\nYour database and .env have been preserved in $INSTDIR."
SectionEnd

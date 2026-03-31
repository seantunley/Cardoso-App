; Cardoso Customer Manager — Windows Installer
; Requires: NSIS 3.x, Node.js bundled in build/node/, NSSM in build/nssm/
; Build via: makensis windows/installer.nsi

!define APP_NAME "Cardoso Customer Manager"
!define SERVICE_NAME "CardosoCigarettes"
!define APP_DIR "C:\Cardoso Customer App"
!define OUT_FILE "CardosoSetup.exe"
!define PUBLISHER "Cardoso"
!define UNINSTALLER "Uninstall.exe"

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
  SetOutPath "$INSTDIR"

  ; Copy all app files
  File /r "..\dist\*"
  File /r "..\src\*"
  File "..\server.js"
  File "..\package.json"
  File "..\package-lock.json"
  File /r "..\scripts\*"
  File /r "..
ode_modules\*"

  ; Copy bundled Node.js runtime
  SetOutPath "$INSTDIR\node"
  File /r ".\build\node\*"

  ; Copy NSSM
  SetOutPath "$INSTDIR\nssm"
  File ".\build\nssm\nssm.exe"

  ; Create logs dir
  CreateDirectory "$INSTDIR\logs"
  CreateDirectory "$INSTDIR\database"

  ; Write .env file with config from installer page
  FileOpen $0 "$INSTDIR\.env" w
  FileWrite $0 "NODE_ENV=production$\r$\n"
  FileWrite $0 "PORT=$PortValue$\r$\n"
  FileWrite $0 "SITE_NAME=$SiteNameValue$\r$\n"
  FileWrite $0 "DB_PATH=./database/cardoso.db$\r$\n"
  ; SESSION_SECRET — generate a random 32-char string
  FileWrite $0 "SESSION_SECRET=CHANGE_ME_RUN_SETUP$\r$\n"
  FileWrite $0 "ENCRYPTION_KEY=$\r$\n"
  FileClose $0

  ; Install npm dependencies (uses bundled Node)

  ; Install Windows service via NSSM
  ExecWait '"$INSTDIR\nssm\nssm.exe" install ${SERVICE_NAME} "$INSTDIR\node\node.exe" "server.js"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppDirectory "$INSTDIR"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppEnvironmentExtra "NODE_ENV=production"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} DisplayName "${APP_NAME}"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} Description "Cardoso Customer Manager — runs as background service"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} Start SERVICE_AUTO_START' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppStdout "$INSTDIR\logs\service.log"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppStderr "$INSTDIR\logs\service-error.log"' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppRotateFiles 1' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" set ${SERVICE_NAME} AppRotateSeconds 86400' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" start ${SERVICE_NAME}' $0

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

  MessageBox MB_OK "Cardoso is installed and running.$\n$\nOpen: http://localhost:$PortValue$\n$\nIMPORTANT: Edit $INSTDIR\.env and set SESSION_SECRET and ENCRYPTION_KEY, then restart the service."
SectionEnd

Section "Uninstall"
  ExecWait '"$INSTDIR\nssm\nssm.exe" stop ${SERVICE_NAME}' $0
  ExecWait '"$INSTDIR\nssm\nssm.exe" remove ${SERVICE_NAME} confirm' $0

  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\nssm"
  RMDir /r "$INSTDIR\src"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\scripts"
  Delete "$INSTDIR\server.js"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\${UNINSTALLER}"
  Delete "$DESKTOP\Cardoso.lnk"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE_NAME}"

  MessageBox MB_OK "Cardoso has been uninstalled.$\nYour database and .env have been preserved in $INSTDIR."
SectionEnd

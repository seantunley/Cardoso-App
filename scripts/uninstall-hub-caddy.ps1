<#
.SYNOPSIS
  Remove the Caddy Windows service installed by install-hub-caddy.ps1.
  Caddy binary, config, certs, and logs stay on disk so you can restore
  by re-running the install script.

.DESCRIPTION
  Use this if you need to roll the Hub back to plain HTTP, or before
  switching to a different reverse-proxy stack. Doesn't touch the
  Cardoso Hub Node service.
#>
param(
  [Parameter()][string]$AppDir = "C:\Cardoso Customer App",
  [Parameter()][string]$ServiceName = "CardosoCaddy",
  [Parameter()][switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "This script must be run as Administrator."
  exit 1
}

$nssmPath = Join-Path $AppDir "nssm\nssm.exe"
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "Stopping $ServiceName..."
  & $nssmPath stop $ServiceName 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  Write-Host "Removing $ServiceName..."
  & $nssmPath remove $ServiceName confirm 2>&1 | Out-Null
  Write-Host "Service removed."
} else {
  Write-Host "$ServiceName not installed — nothing to do."
}

if ($RemoveFiles) {
  $caddyDir = "C:\Caddy"
  if (Test-Path $caddyDir) {
    Write-Host "Removing $caddyDir..."
    Remove-Item -Recurse -Force $caddyDir
  }
}

Write-Host ""
Write-Host "Hub Caddy uninstalled."
Write-Host "The Hub Node service is unaffected and still serving on its configured port."
Write-Host ""
Write-Host "If you set BIND_ADDRESS=127.0.0.1 in the Hub's .env when adding Caddy,"
Write-Host "remove that line (or change to 0.0.0.0) before sites can reach the Hub directly again."

<#
.SYNOPSIS
  Install Caddy as a reverse proxy in front of the Cardoso Hub, with TLS
  certificates issued by Tailscale (Let's Encrypt, DNS-01 challenge —
  no public DNS or open ports required).

.DESCRIPTION
  See docs/plans/https-rollout.md Phase 1 for design rationale.
  See docs/ops/hub-tls.md for operator runbook.

  Idempotent: safe to re-run. Re-issues the cert, regenerates the
  Caddyfile, and reinstalls the Windows service.

.PARAMETER Hostname
  The Tailscale hostname to serve TLS on. Format:
  <machine>.<tailnet>.ts.net
  (e.g., 'hub.tail-12345.ts.net'). Required.

.PARAMETER BackendPort
  Port the Cardoso Hub Node service is listening on. Default 3001.

.PARAMETER CaddyDir
  Where Caddy gets installed. Default 'C:\Caddy'.

.PARAMETER AppDir
  Where the Cardoso Customer App lives. Default 'C:\Cardoso Customer App'.
  Must contain 'nssm\nssm.exe' (provided by the Cardoso installer).

.PARAMETER ServiceName
  Windows service name for Caddy. Default 'CardosoCaddy'.

.PARAMETER SkipDownload
  Skip downloading Caddy. Useful when re-running with an existing
  C:\Caddy\caddy.exe.

.EXAMPLE
  .\install-hub-caddy.ps1 -Hostname "hub.tail-12345.ts.net"

.EXAMPLE
  # Local dev install — point at the dev server on a custom port
  .\install-hub-caddy.ps1 -Hostname "devbox.tail-12345.ts.net" -BackendPort 3101
#>
param(
  [Parameter(Mandatory=$true)][string]$Hostname,
  [Parameter()][int]$BackendPort = 3001,
  # Public TLS port Caddy listens on. Default 443. Override (e.g. 8443) when
  # the box is also running IIS / Sage 300 Web API / Certificate Services
  # which already own port 443 via HTTP.sys reservations — Caddy cannot
  # bind there even with no active listener (WSAEACCES).
  [Parameter()][int]$ListenPort = 443,
  [Parameter()][string]$CaddyDir = "C:\Caddy",
  [Parameter()][string]$AppDir = "C:\Cardoso Customer App",
  [Parameter()][string]$ServiceName = "CardosoCaddy",
  [Parameter()][switch]$SkipDownload
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # speed up Invoke-WebRequest

# Need admin to install services / write to Program Files
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error "This script must be run as Administrator."
  exit 1
}

Write-Host "================================================================"
Write-Host " Cardoso Hub Caddy install"
Write-Host "  Hostname:    $Hostname"
Write-Host "  Backend:     127.0.0.1:$BackendPort"
Write-Host "  Caddy dir:   $CaddyDir"
Write-Host "  Service:     $ServiceName"
Write-Host "================================================================"
Write-Host ""

# 1. Verify prerequisites ─────────────────────────────────────────────────
Write-Host "[1/7] Checking prerequisites..."

$nssmPath = Join-Path $AppDir "nssm\nssm.exe"
if (-not (Test-Path $nssmPath)) {
  Write-Error "NSSM not found at $nssmPath. Install the Cardoso Customer App first (it ships NSSM)."
  exit 1
}

$tailscaleCmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscaleCmd) {
  # Tailscale's installer puts it under Program Files but doesn't always
  # add it to PATH for non-interactive sessions. Probe known locations.
  $tailscaleCandidates = @(
    "C:\Program Files\Tailscale\tailscale.exe",
    "C:\Program Files (x86)\Tailscale\tailscale.exe"
  )
  $tailscale = $tailscaleCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $tailscale) {
    Write-Error "tailscale.exe not found. Install Tailscale first and ensure this machine is connected to your tailnet."
    exit 1
  }
} else {
  $tailscale = $tailscaleCmd.Source
}

# Sanity-check that this machine is on Tailscale
$tsStatus = & $tailscale status --json 2>$null | ConvertFrom-Json
if (-not $tsStatus -or $tsStatus.BackendState -ne "Running") {
  Write-Error "Tailscale is installed but not connected. Run 'tailscale up' and retry."
  exit 1
}
Write-Host "  - NSSM:       found"
Write-Host "  - Tailscale:  $tailscale (state: $($tsStatus.BackendState))"

# 2. Download Caddy ───────────────────────────────────────────────────────
Write-Host "[2/7] Installing Caddy..."

if ((-not $SkipDownload) -or (-not (Test-Path "$CaddyDir\caddy.exe"))) {
  New-Item -ItemType Directory -Force -Path $CaddyDir | Out-Null
  $caddyZip = Join-Path $env:TEMP "caddy.zip"
  # PowerShell 5.1 defaults to TLS 1.0 which github.com no longer accepts.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  # Caddy's release assets embed the version in the filename
  # (caddy_2.X.Y_windows_amd64.zip), so the old
  # /releases/latest/download/caddy_windows_amd64.zip alias 404s. Query
  # the GitHub API to find the actual current asset URL instead.
  Write-Host "  Resolving latest Caddy release via GitHub API..."
  $caddyApi = "https://api.github.com/repos/caddyserver/caddy/releases/latest"
  $caddyHeaders = @{ 'User-Agent' = 'Cardoso-Hub-Installer'; 'Accept' = 'application/vnd.github+json' }
  $caddyMeta = Invoke-RestMethod -Uri $caddyApi -Headers $caddyHeaders -UseBasicParsing
  $caddyAsset = $caddyMeta.assets | Where-Object { $_.name -match '^caddy_[\d\.]+_windows_amd64\.zip$' } | Select-Object -First 1
  if (-not $caddyAsset) {
    Write-Error "Couldn't find a windows_amd64.zip asset in Caddy release $($caddyMeta.tag_name)."
    exit 1
  }
  $caddyUrl = $caddyAsset.browser_download_url
  Write-Host "  Downloading $($caddyAsset.name) ($([math]::Round($caddyAsset.size / 1MB, 1)) MB) from $caddyUrl..."
  Invoke-WebRequest -Uri $caddyUrl -OutFile $caddyZip -UseBasicParsing
  Expand-Archive -Path $caddyZip -DestinationPath $CaddyDir -Force
  Remove-Item $caddyZip -Force
  Write-Host "  Caddy installed to $CaddyDir\caddy.exe"
} else {
  Write-Host "  Using existing $CaddyDir\caddy.exe (--SkipDownload)"
}

# 3. Issue Tailscale cert ─────────────────────────────────────────────────
Write-Host "[3/7] Issuing TLS cert via Tailscale..."

$certFile = Join-Path $CaddyDir "$Hostname.crt"
$keyFile  = Join-Path $CaddyDir "$Hostname.key"

Push-Location $CaddyDir
try {
  & $tailscale cert $Hostname
  if ($LASTEXITCODE -ne 0) {
    Write-Error "tailscale cert failed. Common causes:"
    Write-Error "  1. HTTPS for tailnet machines is not enabled in the Tailscale admin panel."
    Write-Error "     Enable at: https://login.tailscale.com/admin/dns (toggle 'HTTPS Certificates')."
    Write-Error "  2. The hostname '$Hostname' doesn't match this machine's tailnet name."
    Write-Error "     Check 'tailscale status' for the correct hostname."
    exit 1
  }
} finally {
  Pop-Location
}

if (-not (Test-Path $certFile) -or -not (Test-Path $keyFile)) {
  Write-Error "tailscale cert reported success but $certFile / $keyFile not found."
  exit 1
}
Write-Host "  Cert issued: $certFile"

# 4. Generate Caddyfile ───────────────────────────────────────────────────
Write-Host "[4/7] Generating Caddyfile..."

$logsDir = Join-Path $CaddyDir "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$caddyfile = @"
# Cardoso Hub Caddy config — generated by scripts/install-hub-caddy.ps1
# Re-running the script regenerates this file. Manual edits will be
# overwritten. Customize via the script's parameters or fork the
# template at windows/Caddyfile.template if you need long-term changes.

# Disable Caddy's automatic HTTP→HTTPS redirect on port 80. Without this,
# Caddy ALSO tries to bind :80, which fails with "forbidden by its access
# permissions" on hub boxes that share the host with IIS / Sage 300 Web
# API (HTTP.sys reserves :80 even when no app is listening). The hub is
# internal-tailnet only and operators always type https://, so the 80→443
# redirect adds no value here.
{
    auto_https disable_redirects
}

${Hostname}$(if ($ListenPort -ne 443) { ":$ListenPort" }) {
    # TLS cert issued by Tailscale (Let's Encrypt under the hood).
    # Renew with: tailscale cert $Hostname
    # Renewal is automatic ~30 days before expiry as long as the
    # tailnet stays connected.
    tls $CaddyDir\$Hostname.crt $CaddyDir\$Hostname.key

    # Reverse proxy to the Cardoso Hub Node service.
    reverse_proxy http://127.0.0.1:$BackendPort {
        # Pass through the real client IP so Express's req.ip and
        # rate-limiting work correctly. Hub already trusts proxy hop 1.
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    encode gzip

    # Strip the default 'Server: Caddy' response header so we don't
    # advertise the stack to anyone scanning.
    header -Server

    log {
        output file $logsDir\access.log {
            roll_size 100mb
            roll_keep 14
        }
        format console
        level INFO
    }
}
"@

$caddyfilePath = Join-Path $CaddyDir "Caddyfile"
Set-Content -Path $caddyfilePath -Value $caddyfile -Encoding ASCII
Write-Host "  Caddyfile: $caddyfilePath"

# Validate the Caddyfile parses before we register the service
& "$CaddyDir\caddy.exe" validate --config $caddyfilePath
if ($LASTEXITCODE -ne 0) {
  Write-Error "Caddy refused to parse the generated Caddyfile. Bug in the script — please report."
  exit 1
}
Write-Host "  Caddyfile validates clean"

# 5. Stop existing service if present ─────────────────────────────────────
Write-Host "[5/7] Configuring Windows service..."

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "  Stopping existing $ServiceName..."
  & $nssmPath stop $ServiceName 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  & $nssmPath remove $ServiceName confirm 2>&1 | Out-Null
  Start-Sleep -Seconds 1
}

# 6. Install Caddy as a Windows service via NSSM ──────────────────────────
& $nssmPath install $ServiceName "$CaddyDir\caddy.exe" "run --config $caddyfilePath" | Out-Null
& $nssmPath set $ServiceName AppDirectory $CaddyDir | Out-Null
& $nssmPath set $ServiceName DisplayName "Cardoso Hub Caddy" | Out-Null
& $nssmPath set $ServiceName Description "Caddy reverse proxy with TLS in front of the Cardoso Hub Node service" | Out-Null
& $nssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssmPath set $ServiceName AppStdout (Join-Path $logsDir "service.log") | Out-Null
& $nssmPath set $ServiceName AppStderr (Join-Path $logsDir "service-error.log") | Out-Null
& $nssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $nssmPath set $ServiceName AppRotateSeconds 86400 | Out-Null

Write-Host "  Service installed: $ServiceName"

# 7. Start service and verify ─────────────────────────────────────────────
Write-Host "[6/7] Starting service..."
& $nssmPath start $ServiceName | Out-Null
Start-Sleep -Seconds 4

$svc = Get-Service -Name $ServiceName
if ($svc.Status -ne 'Running') {
  Write-Error "$ServiceName failed to start (status: $($svc.Status))."
  Write-Error "Check $logsDir\service-error.log for details."
  if (Test-Path "$logsDir\service-error.log") {
    Write-Host ""
    Write-Host "Last 20 lines of service-error.log:"
    Get-Content "$logsDir\service-error.log" -Tail 20
  }
  exit 1
}

Write-Host "[7/7] Smoke testing..."
try {
  $resp = Invoke-WebRequest -Uri "https://${Hostname}$(if ($ListenPort -ne 443) { ":$ListenPort" })/api/health" -UseBasicParsing -TimeoutSec 10
  if ($resp.StatusCode -eq 200) {
    Write-Host "  https://${Hostname}$(if ($ListenPort -ne 443) { ":$ListenPort" })/api/health -> 200 OK"
  } else {
    Write-Warning "  https://${Hostname}$(if ($ListenPort -ne 443) { ":$ListenPort" })/api/health -> $($resp.StatusCode) (Caddy is up but the backend response is unexpected)"
  }
} catch {
  Write-Warning "  Smoke test failed: $_"
  Write-Warning "  Caddy is running but couldn't reach the backend. Check that the Hub Node service is up on port $BackendPort."
}

Write-Host ""
Write-Host "================================================================"
Write-Host " Done. Caddy is serving the Hub on https://${Hostname}$(if ($ListenPort -ne 443) { ":$ListenPort" })"
Write-Host "================================================================"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Open https://${Hostname}$(if ($ListenPort -ne 443) { ":$ListenPort" }) in a browser. Should show the Hub UI"
Write-Host "     with a valid TLS cert and no warnings."
Write-Host ""
Write-Host "  2. Update each site's HUB_URL config to use https://${Hostname}$(if ($ListenPort -ne 443) { ":$ListenPort" })"
Write-Host "     (was http://$Hostname`:$BackendPort or similar)."
Write-Host ""
Write-Host "  3. Once all sites are migrated, lock the Hub Node service to"
Write-Host "     localhost-only by adding to .env:"
Write-Host "       BIND_ADDRESS=127.0.0.1"
Write-Host "     then restart the CardosoCigarettes service."
Write-Host ""
Write-Host "  4. Optionally re-enable helmet's HTTPS-only protections by"
Write-Host "     adding to .env:"
Write-Host "       TLS_FRONTING=true"
Write-Host "     See docs/plans/https-rollout.md Phase 1 step 8 for the"
Write-Host "     specific protections this turns on."
Write-Host ""
Write-Host "Logs:"
Write-Host "  $logsDir\access.log         - per-request access log"
Write-Host "  $logsDir\service.log        - Caddy stdout"
Write-Host "  $logsDir\service-error.log  - Caddy stderr"
Write-Host ""
Write-Host "Manage the service:"
Write-Host "  Get-Service $ServiceName"
Write-Host "  & '$nssmPath' restart $ServiceName"
Write-Host "  & '$nssmPath' stop $ServiceName"
Write-Host ""

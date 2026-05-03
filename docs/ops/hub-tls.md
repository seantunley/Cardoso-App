# Hub TLS — operator runbook

The Cardoso Hub serves its UI and API on `https://<machine>.<tailnet>.ts.net`
via Caddy as a reverse proxy. Caddy obtains a real Let's Encrypt cert
from Tailscale's built-in `tailscale cert` workflow (DNS-01 challenge,
no public DNS or open ports needed). The Cardoso Node service runs on
`127.0.0.1:3001` behind it.

This document covers: first install, day-to-day ops, and recovery.

For the design rationale see [`docs/plans/https-rollout.md`](../plans/https-rollout.md).

---

## First install

### Prerequisites
1. Cardoso Customer App is already installed at `C:\Cardoso Customer App`
   (the standard EXE installer ships NSSM, which the Caddy script reuses).
2. Tailscale is installed on the Hub machine and connected to your tailnet.
3. **HTTPS for tailnet machines is enabled** in the Tailscale admin
   panel: <https://login.tailscale.com/admin/dns> → toggle on
   "HTTPS Certificates". This is the Tailscale-side flip that authorises
   `tailscale cert` to fetch Let's Encrypt certs for `*.ts.net` names.
4. You know the Hub's tailnet hostname — `tailscale status` on the Hub
   shows it as the first column for the local machine, in the form
   `<machine>.<tailnet>.ts.net`.

### Run the installer

From an **elevated PowerShell** on the Hub:

```powershell
cd "C:\Cardoso Customer App\scripts"
.\install-hub-caddy.ps1 -Hostname "hub.<tailnet>.ts.net"
```

The script is idempotent. It:
1. Checks NSSM + Tailscale prerequisites.
2. Downloads Caddy to `C:\Caddy\caddy.exe`.
3. Issues a TLS cert via `tailscale cert`.
4. Generates `C:\Caddy\Caddyfile`.
5. Validates the Caddyfile parses.
6. Installs `CardosoCaddy` as a Windows service via NSSM.
7. Starts the service.
8. Smoke-tests `https://<hostname>/api/health`.

Total time: ~1 minute.

### Lock the Node service to localhost

After Caddy is verified working, edit `C:\Cardoso Customer App\.env`
and add:

```
BIND_ADDRESS=127.0.0.1
```

Then restart the Cardoso Node service:

```powershell
& "C:\Cardoso Customer App\nssm\nssm.exe" restart CardosoCigarettes
```

This binds Node to loopback only — the LAN can't reach it directly any
more, only Caddy on the same machine. Defense in depth.

### Re-enable helmet's HTTPS-only protections

Once you're confident the HTTPS path is solid, add to `.env`:

```
TLS_FRONTING=true
```

Restart `CardosoCigarettes`. This flips on `HSTS`,
`Content-Security-Policy` with `upgrade-insecure-requests`,
`Cross-Origin-Opener-Policy`, and `Origin-Agent-Cluster` —
all the security headers that were disabled for HTTP-on-LAN compatibility.

If anything in the UI breaks (charts, BAT preview, etc.), set
`TLS_FRONTING=false` and restart, then iterate on the CSP directives in
[`server.js`](../../server.js) before re-enabling.

### Update sites' Hub URL

Each site has a `HUB_URL` env var pointing at the Hub it pushes data to.
Update from `http://<hostname>:3001` to `https://<hostname>` (no port —
443 is implicit) and restart each site service.

This is the change that ships in the next site EXE installer release.
Existing installs need their `.env` edited manually until they upgrade.

---

## Day-to-day

### Service management

```powershell
# Status
Get-Service CardosoCaddy

# Restart after a config change
& "C:\Cardoso Customer App\nssm\nssm.exe" restart CardosoCaddy

# Stop / start
& "C:\Cardoso Customer App\nssm\nssm.exe" stop CardosoCaddy
& "C:\Cardoso Customer App\nssm\nssm.exe" start CardosoCaddy
```

### Logs

```
C:\Caddy\logs\access.log         # per-request access log, rolled at 100MB
C:\Caddy\logs\service.log        # Caddy stdout
C:\Caddy\logs\service-error.log  # Caddy stderr (parse errors, cert issues)
```

The Cardoso Node logs stay where they always were:
`C:\Cardoso Customer App\logs\service*.log`.

### Cert renewal

`tailscale cert` issues a Let's Encrypt cert with the standard 90-day
lifetime. Tailscale auto-renews ~30 days before expiry as long as the
machine stays on the tailnet — no operator action required.

If you ever need to force a renewal:

```powershell
cd C:\Caddy
tailscale cert <hostname>.<tailnet>.ts.net
& "C:\Cardoso Customer App\nssm\nssm.exe" restart CardosoCaddy
```

### Changing the hostname

If the Hub's tailnet name changes (renamed machine, moved tailnet):

1. Re-run `install-hub-caddy.ps1` with the new `-Hostname`.
2. The script will issue a fresh cert, regenerate the Caddyfile, and
   reinstall the service.
3. Update every site's `HUB_URL` to the new hostname.
4. Old cert files in `C:\Caddy\` can be deleted manually.

---

## Verification

After install, all of these should be true:

```powershell
# 1. Caddy service is running
Get-Service CardosoCaddy
# Status: Running

# 2. Caddy is listening on 443
netstat -an | Select-String ":443"
# Should show LISTENING

# 3. The cert files exist
Test-Path "C:\Caddy\<hostname>.crt"
# True
Test-Path "C:\Caddy\<hostname>.key"
# True

# 4. The hub answers over HTTPS
Invoke-WebRequest -Uri "https://<hostname>/api/health" -UseBasicParsing
# StatusCode: 200

# 5. The Node service is bound to localhost (after BIND_ADDRESS=127.0.0.1)
netstat -an | Select-String "127.0.0.1:3001"
# Should show LISTENING on 127.0.0.1:3001
netstat -an | Select-String "0.0.0.0:3001"
# Should show NOTHING — no LAN exposure

# 6. Browse the Hub
Start-Process "https://<hostname>"
# Browser shows valid lock icon, no warnings
```

---

## Recovery

### Caddy won't start

```powershell
Get-Content C:\Caddy\logs\service-error.log -Tail 30
```

Common causes:
- **Port 443 is already in use** by something else (IIS, another reverse
  proxy). Stop or reconfigure the other service.
- **Cert files missing.** Re-run the installer with `-SkipDownload`.
- **Caddyfile parse error.** Validate manually:
  `& "C:\Caddy\caddy.exe" validate --config C:\Caddy\Caddyfile`.
- **NSSM service is wedged.** Remove and reinstall:
  ```powershell
  cd "C:\Cardoso Customer App\scripts"
  .\uninstall-hub-caddy.ps1
  .\install-hub-caddy.ps1 -Hostname "<hostname>"
  ```

### Cert expired / invalid

`tailscale cert <hostname>` to re-issue, then restart Caddy. If
`tailscale cert` itself fails:
- Verify `tailscale status` shows the machine as connected.
- Verify HTTPS Certificates is still enabled in the Tailscale admin
  panel.
- Check `tailscale netcheck` for connectivity issues.

### Sites can't reach the Hub

Symptoms: site logs show connection-refused, timeouts, or TLS errors
when posting to the Hub.

1. **Did you set `BIND_ADDRESS=127.0.0.1` on the Hub but forget to add
   Caddy?** Roll back: edit `.env`, comment out the line, restart Node.
2. **Site `HUB_URL` still uses HTTP or the wrong port?** Update site
   config to `https://<hostname>` (no port).
3. **Tailscale connectivity?** From the site, `Test-NetConnection
   <hostname> -Port 443` should succeed.

### Full rollback to plain HTTP

Run the uninstaller, restore `.env`:

```powershell
cd "C:\Cardoso Customer App\scripts"
.\uninstall-hub-caddy.ps1
```

Then edit `C:\Cardoso Customer App\.env`:
- Remove `BIND_ADDRESS=127.0.0.1` (or change to `0.0.0.0`)
- Remove `TLS_FRONTING=true`

Restart `CardosoCigarettes`. The Hub is back on plain HTTP at port 3001
on the LAN.

Sites need their `HUB_URL` reverted to `http://<hostname>:3001` until
HTTPS is reinstated.

# Local test plan — Hub Caddy on your dev machine

End-to-end smoke test of the Hub TLS rollout *without* touching the
production Hub. Treat your local Windows dev box as if it were the Hub
and verify the install-hub-caddy.ps1 flow works on real hardware.

## Pre-flight

- Your dev machine is on Tailscale (you mentioned earlier the remote
  site is Tailscale-only — your dev machine should be on the same
  tailnet).
- HTTPS for tailnet machines is enabled in the Tailscale admin panel.
- The Cardoso Customer App EXE installer is **not** required for the
  local test; the Caddy script needs `nssm.exe` from the install dir.
  If the dev box doesn't have it, set `-AppDir` to wherever you have
  nssm.

## What this exercises

- `install-hub-caddy.ps1` end-to-end: Caddy download, cert issuance,
  Caddyfile generation, NSSM service registration, smoke test
- `BIND_ADDRESS=127.0.0.1` in `.env` actually binds Node to loopback
- `TLS_FRONTING=true` enables the helmet HTTPS hardening without
  breaking the UI
- The Hub UI loads cleanly via `https://<machine>.<tailnet>.ts.net`

## Steps

### 1. Get your machine's tailnet hostname

```powershell
tailscale status
```

The first column for the local machine is your hostname, in the form
`<machine>.<tailnet>.ts.net` — e.g., `seans-laptop.tail-12345.ts.net`.

### 2. Run the installer (elevated PowerShell)

```powershell
cd "C:\path\to\Cardoso-app\scripts"
.\install-hub-caddy.ps1 -Hostname "<your-machine>.<tailnet>.ts.net" -BackendPort 3101
```

`-BackendPort 3101` because the dev server runs on 3101, not the
production 3001. (If your dev runs on 3001, omit the flag.)

Expected output: 7 numbered steps, ending with
`Done. Caddy is serving the Hub on https://<hostname>` and a smoke-test
"200 OK" line.

If the smoke test fails because Node isn't running, that's fine for now
— start the dev server (`npm run dev`) and continue.

### 3. Verify in a browser

Open `https://<your-machine>.<tailnet>.ts.net` from any device on the
tailnet (your phone if it's on Tailscale, another laptop, etc).

Expected:
- Valid lock icon, no warnings
- Hub UI loads
- Login flow works (cookies are issued from the HTTPS origin, no mixed
  content)

### 4. Test BIND_ADDRESS=127.0.0.1

Stop your dev server. Edit a `.env` (or just set the env var
inline for the test):

```powershell
$env:BIND_ADDRESS = "127.0.0.1"
npm run dev
```

The boot log should print:
```
🚀 Local backend + SQLite running at http://127.0.0.1:3101
[system.boot] ... bind=127.0.0.1, tls_fronting=false
```

From a *different* tailnet device, hit:
- `https://<hostname>` → should still work (Caddy proxies to localhost)
- `http://<hostname>:3101` → should fail (Node no longer listens on
  the LAN)

This proves the localhost binding is enforced and Caddy is the only
ingress.

### 5. Test TLS_FRONTING=true

Stop the dev server, set both env vars:

```powershell
$env:BIND_ADDRESS = "127.0.0.1"
$env:TLS_FRONTING = "true"
npm run dev
```

Boot log should now say `tls_fronting=true`.

Browse the Hub UI. Open DevTools → Network tab. On any response,
inspect the headers. You should see:

- `Strict-Transport-Security: max-age=15552000`
- `Content-Security-Policy: ...upgrade-insecure-requests...`
- `Cross-Origin-Opener-Policy: same-origin`
- `Origin-Agent-Cluster: ?1`

Click around the app — Customer Search, BAT, Reports. Anything that
looks broken (charts not rendering, BAT preview iframe failing, fonts
missing) means the CSP needs tuning. Note exactly what breaks; we
iterate the directives in [server.js](../../server.js) until the UI is
clean.

### 6. Tear down

When you're done:

```powershell
cd "C:\path\to\Cardoso-app\scripts"
.\uninstall-hub-caddy.ps1
```

Then unset the env vars:
```powershell
Remove-Item Env:BIND_ADDRESS
Remove-Item Env:TLS_FRONTING
```

Or just stop the dev server — it picks up the absence on next start.

## Things to verify before declaring done

- [ ] Installer runs to completion on a machine that's never had Caddy
- [ ] Re-running the installer is idempotent (no errors, same result)
- [ ] Cert issuance via `tailscale cert` succeeds
- [ ] Caddy starts as a Windows service and survives a reboot
- [ ] Hub UI loads at `https://<hostname>` from another tailnet device
- [ ] `BIND_ADDRESS=127.0.0.1` blocks LAN access to port 3101
- [ ] `TLS_FRONTING=true` doesn't break the UI (or we know what to fix
      in CSP)
- [ ] Uninstaller cleanly removes the service

If any check fails, we iterate before rolling out to the actual remote
Hub.

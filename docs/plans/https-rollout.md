# HTTPS rollout — Caddy + internal CA

Add TLS everywhere. Driven by compliance / audit requirements; the Hub
and every site need TLS at the application layer, not just the
Tailscale tunnel underneath.

## Why two phases

- **Phase 1** is the Hub. Cheap (1-2 days), high audit value, low risk.
  Caddy on the Hub + a Tailscale-issued Let's Encrypt cert. Done in one
  afternoon if the Hub server is in good shape.
- **Phase 2** is the per-site installs. More involved (5-7 days)
  because every site is a Windows box that doesn't have a public
  hostname, and we need an internal CA so site staff don't see browser
  warnings.

The phases are independent. Phase 1 unblocks the audit's biggest
exposure — the Hub UI. Phase 2 closes the remaining gap on site UI
access.

## Constraints carried over

- **Network topology**: everything is Tailscale-only. No public Let's
  Encrypt HTTP-01 challenge possible at the network edge. Hub uses
  Tailscale's built-in cert tooling; sites use an internal CA.
- **Scope**: Hub + sites. Decided.
- **Audit**: TLS at the application layer required (Tailscale's
  WireGuard alone isn't enough for the audit framework).
- **Site UI access**: store staff need to reach the site UI on the
  local LAN over HTTPS without browser warnings → internal CA root
  must be in the Windows trust store on every site.

---

# Phase 1 — Hub HTTPS via Caddy + Tailscale

## Goal

`https://hub.<tailnet>.ts.net` serves the Hub UI with a real
Let's Encrypt-issued cert that any browser trusts (no internal-CA-cert
distribution needed for the Hub specifically because Tailscale handles
the issuance).

## Prerequisites

- Hub server is on Tailscale (already confirmed).
- HTTPS on the tailnet is enabled in the Tailscale admin panel
  (`Settings → DNS → HTTPS Certificates`).
- Hub server has a stable Tailscale machine name (e.g. `hub`).

## Work

### 1. Install Caddy on the Hub (~30 min)

```powershell
# Download caddy.exe to C:\Caddy\caddy.exe
$url = "https://github.com/caddyserver/caddy/releases/latest/download/caddy_windows_amd64.zip"
Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\caddy.zip"
Expand-Archive "$env:TEMP\caddy.zip" -DestinationPath "C:\Caddy" -Force
```

### 2. Caddyfile (~15 min)

`C:\Caddy\Caddyfile`:

```
hub.<tailnet>.ts.net {
    reverse_proxy http://127.0.0.1:3001
    encode gzip
    log {
        output file C:\Caddy\logs\access.log {
            roll_size 100mb
            roll_keep 14
        }
    }
}
```

The `<tailnet>.ts.net` hostname is automatically set up by Tailscale
once HTTPS for tailnet machines is enabled.

### 3. Issue the cert via Tailscale (~5 min)

```powershell
tailscale cert hub.<tailnet>.ts.net
```

Drops `hub.<tailnet>.ts.net.crt` and `.key` in the working dir. Caddy
can pick those up directly OR be configured to call this command itself
on first run / renewal.

Cleaner approach: configure Caddy to use Tailscale's TLS automation
plugin if/when it lands, or run a small script via Task Scheduler that
re-issues the cert on a schedule.

### 4. Install Caddy as a Windows service (~30 min)

Use the existing NSSM bundled with the Cardoso installer:

```powershell
& "C:\Cardoso Customer App\nssm\nssm.exe" install CardosoCaddy `
  "C:\Caddy\caddy.exe" `
  "run --config C:\Caddy\Caddyfile"
& "C:\Cardoso Customer App\nssm\nssm.exe" set CardosoCaddy AppDirectory "C:\Caddy"
& "C:\Cardoso Customer App\nssm\nssm.exe" set CardosoCaddy Start SERVICE_AUTO_START
& "C:\Cardoso Customer App\nssm\nssm.exe" start CardosoCaddy
```

### 5. Lock down the Node service to localhost (~15 min)

The Node Express server currently binds to `0.0.0.0:3001`. With Caddy
in front, it should only accept connections from Caddy on the same
machine. Change `server.js`:

```js
// before
app.listen(PORT, '0.0.0.0', ...)
// after
app.listen(PORT, '127.0.0.1', ...)
```

Or make it env-driven: `BIND_ADDRESS` defaults to `127.0.0.1` in
production, `0.0.0.0` in dev.

### 6. Update site config to point at HTTPS Hub (~30 min)

Sites currently push to `http://hub.<tailnet>.ts.net:3001`. Update the
site's `HUB_URL` env to `https://hub.<tailnet>.ts.net`. This change
ships in the next site installer.

Until every site has been updated, Caddy can listen on both 443 (TLS)
and 3001 (plain) for a transition period — drop the 3001 listener once
all sites are on the new URL.

### 7. Smoke tests (~30 min)

- `curl https://hub.<tailnet>.ts.net/api/health` returns 200
- Browser to the same URL shows the Hub UI, valid lock icon, no warnings
- `tail` on `C:\Caddy\logs\access.log` shows the request
- Tailscale ACL still reachable (confirm by hitting the URL from a
  different Tailscale node)

### 8. Re-enable helmet security headers (~15 min)

The Hub Express server currently runs `helmet()` with four
HTTPS-dependent protections disabled because they break on HTTP:

```js
app.use(helmet({
  hsts: false,                      // forces HTTPS — pointless on HTTP
  contentSecurityPolicy: false,     // includes upgrade-insecure-requests
  crossOriginOpenerPolicy: false,   // requires HTTPS for cross-origin isolation
  originAgentCluster: false,        // same
}));
```

Once Caddy is fronting the Hub on HTTPS, flip them back on with
sensible policy:

```js
app.use(helmet({
  hsts: { maxAge: 15552000, includeSubDomains: false },  // 180 days
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'upgrade-insecure-requests': [],
      // tighten further once we know what the Hub UI actually loads
    },
  },
  // crossOriginOpenerPolicy + originAgentCluster default to safe values
}));
```

Roll this out cautiously — turn one protection back on, deploy,
watch for breakages in the UI (fonts, images, the BAT preview
iframe, any embedded charts), iterate. Don't ship all four at once.
The Hub's CSP in particular will need tuning to not break the BAT
PDF preview surface or any embedded chart libraries.

This step is the security audit's headline payoff — going from "HTTP
with safety features disabled" to "HTTPS with the standard helmet
hardening" closes a real gap in the threat model.

### 9. Document (~30 min)

`docs/ops/hub-tls.md`:
- How Caddy is configured
- How to renew the cert (Tailscale handles it, document the manual
  fallback)
- How to rotate the Tailscale machine name without breaking everything
- The helmet config tightening that came with the HTTPS rollout

## Phase 1 effort

**1-2 days, low risk.** Rollback is trivial: stop Caddy, point sites
back at `http://...:3001`. Hub on plain HTTP again, you're back where
you started.

---

# Phase 2 — Sites HTTPS via internal CA + Caddy

## Goal

Every site Windows install serves its UI on
`https://<site-id>.cardoso.internal` (or similar) with a cert issued
by the internal CA. The CA root is installed in the Windows trust
store on every device that needs to access the site UI, so browsers
show a green lock with no warnings.

## Architecture

```
                                         ┌─────────────────────────┐
                                         │  Hub server             │
   ┌──────────────────┐    Tailscale     │                         │
   │ Site PC (store)  │ ◀───────────────▶│  step-ca (port 9000)    │
   │                  │                  │   - root CA             │
   │  Caddy :443      │  ACME requests   │   - intermediate CA     │
   │   ▼ proxies to   │ ◀───────────────▶│   - ACME endpoint       │
   │  Node :3001      │                  │                         │
   │  (localhost-only)│                  │  Hub Caddy :443         │
   └──────────────────┘                  │   - Tailscale cert      │
                                         │  Hub Node :3001         │
                                         │   (localhost-only)      │
                                         └─────────────────────────┘
```

## Why step-ca (not OpenSSL, not Microsoft ADCS)

- **step-ca** (`smallstep/certificates`) is purpose-built for this
  exact use case. Single-binary Go service, runs on Windows, exposes
  an ACME endpoint that Caddy talks to natively, automatic renewal.
- **OpenSSL by hand**: technically works, no automation. Operator
  burden every renewal cycle.
- **Microsoft ADCS**: powerful but only makes sense if you already
  have Active Directory. We don't.
- **Cloudflare / external CA**: requires a public domain and hits the
  internet from sites. Wrong shape for an internal-only deployment.

## Work

### 1. CA infrastructure on the Hub (~1-2 days)

#### Install step-ca

```powershell
# Download step-ca.exe + step.exe (CLI client)
# Both are single Go binaries, ~30 MB each
$smallstepUrl = "https://github.com/smallstep/cli/releases/latest/..."
# Install to C:\step-ca\
```

#### Bootstrap the CA

```powershell
step ca init `
  --name "Cardoso Internal CA" `
  --dns "ca.<tailnet>.ts.net" `
  --address ":9000" `
  --provisioner "admin@cardoso.local" `
  --acme `
  --deployment-type standalone
```

This creates:
- A 10-year root CA cert
- A 1-year intermediate cert (auto-renewed by step-ca)
- An ACME provisioner that Caddy clients can use
- A signed config in `%USERPROFILE%\.step\config\`

#### Run step-ca as a Windows service

```powershell
& nssm install CardosoStepCA `
  "C:\step-ca\step-ca.exe" `
  "C:\path\to\config\ca.json --password-file C:\path\to\password.txt"
& nssm set CardosoStepCA Start SERVICE_AUTO_START
& nssm start CardosoStepCA
```

#### Lock it to Tailscale

step-ca should listen only on the Tailscale interface, not the public
internet. Configure via Windows firewall to allow inbound 9000 only
from the Tailscale subnet.

### 2. DNS strategy (~0.5 day)

Sites need stable hostnames the cert can attest to. Three options
ranked:

#### Option A: Tailscale MagicDNS only (simplest)

Each site is also on Tailscale → automatically gets
`<machine>.<tailnet>.ts.net`. Tell step-ca's ACME provisioner to allow
that domain. Sites get certs for their own ts.net hostname.

Drawback: depends on Tailscale's DNS. If Tailscale is down, names
don't resolve. But sites are useless without Tailscale anyway (no Hub
sync), so this isn't an additional failure mode.

#### Option B: Custom domain + Tailscale split-DNS

Use `<site-id>.cardoso.internal` (we own the .internal TLD by
convention; not actually registered). Configure Tailscale's DNS to
resolve `*.cardoso.internal` to the appropriate Tailscale IPs.

Drawback: more setup. Benefit: cleaner names, decoupled from
Tailscale's branding in URLs.

#### Option C: hosts file entries pushed by the installer

Each site gets a custom hostname. Installer writes entries to
`C:\Windows\System32\drivers\etc\hosts` mapping the hostname to
127.0.0.1.

Drawback: only works for accessors on the same machine. Other LAN
clients can't reach the UI by hostname.

**Recommend Option A.** Sites are on Tailscale anyway. ts.net names
are mildly ugly but the simplest path to working HTTPS.

### 3. Bundle Caddy + root CA in the NSIS installer (~1 day)

Modify `windows/installer.nsi`:

```nsis
; Add to install section
SetOutPath "$INSTDIR\caddy"
File /r ".\build\caddy\caddy.exe"

; Bundle the step-ca root CA cert
SetOutPath "$INSTDIR\certs"
File ".\build\certs\cardoso-root-ca.crt"

; Install root CA into Windows machine trust store
ExecWait '$SYSDIR\certutil.exe -addstore -f Root "$INSTDIR\certs\cardoso-root-ca.crt"' $0

; Generate Caddyfile (with site-id baked in by the build pipeline or
; prompted for during install)
FileOpen $0 "$INSTDIR\caddy\Caddyfile" w
FileWrite $0 "$SiteHostname {$\r$\n"
FileWrite $0 "  reverse_proxy http://127.0.0.1:$PortValue$\r$\n"
FileWrite $0 "  tls {$\r$\n"
FileWrite $0 "    issuer acme {$\r$\n"
FileWrite $0 "      dir https://ca.<tailnet>.ts.net:9000/acme/acme/directory$\r$\n"
FileWrite $0 "      ca https://ca.<tailnet>.ts.net:9000$\r$\n"
FileWrite $0 "    }$\r$\n"
FileWrite $0 "  }$\r$\n"
FileWrite $0 "}$\r$\n"
FileClose $0

; Install Caddy as a Windows service via NSSM
ExecWait '"$INSTDIR\nssm\nssm.exe" install CardosoCaddy "$INSTDIR\caddy\caddy.exe" "run --config $INSTDIR\caddy\Caddyfile"' $0
ExecWait '"$INSTDIR\nssm\nssm.exe" start CardosoCaddy' $0
```

### 4. Site identifier provisioning (~0.5 day)

Each site needs a stable, unique identifier baked into its hostname.
Today the Hub already assigns `site_id` when a site registers. Two
ways to get this onto the site at install time:

- **Pre-allocated**: site operator runs a Hub command to mint an ID
  before installing. Installer prompts for it.
- **First-run registration**: installer asks for site name + city,
  POSTs to Hub on first boot to get assigned an ID, then writes it
  into config and reissues the Caddy cert with the new hostname.

Either works. **Recommend pre-allocated** — simpler installer flow,
operator already knows site identity at install time.

### 5. Caddy auto-renewal (built-in, ~0 day)

Caddy's ACME client renews automatically before the cert expires.
step-ca's default is 24-hour certs which Caddy renews every ~12 hours.
No additional config required.

If step-ca is unreachable during a renewal window, Caddy keeps the
current cert and retries every minute. You'd notice a problem before
the cert actually expires.

### 6. Lock the Node service to localhost on sites too (~15 min)

Same change as Phase 1 step 5, but on every site:

```js
app.listen(PORT, '127.0.0.1', ...)
```

Once Caddy is in front, the Node server should not accept connections
from the LAN directly.

### 7. Per-device root CA distribution for non-site machines (~0.5 day)

If store staff access the site UI from a tablet, their phone, or any
device that's NOT the site PC, that device needs the root CA in its
trust store too. Otherwise the browser shows a security warning.

Three ways to handle:

- **Each device installs the root CA cert manually.** Document the
  process. Operator burden but cheapest.
- **Restrict access to the local site PC.** Bind the site UI to the
  local PC's loopback / single LAN IP, no LAN browsing. Cleanest from
  a "no warnings" standpoint, but doesn't suit multi-device shops.
- **MDM-managed devices**: if any company-owned tablets, push the
  cert via the MDM. Otherwise N/A.

**Recommend "document the manual install"** unless we know all access
is from the site PC alone.

### 8. Re-enable helmet security headers on sites (~15 min)

Same step as Phase 1 step 8, applied to the site's Express server.
Sites currently ship the same helmet config with HTTPS protections
off. Once Caddy is fronting each site, flip them on (HSTS, CSP with
`upgrade-insecure-requests`, COOP, OAC). Same cautious rollout —
one at a time, watch for UI breakage, iterate.

The site has fewer surfaces than the Hub so CSP tuning is simpler,
but verify the BAT preview, customer search, and reports all still
load before rolling to production sites.

### 9. Testing (~1 day)

Stand up two test sites in VMs:

- Verify root CA gets installed into Windows trust store
- Verify Caddy starts, gets a cert from step-ca, serves on 443
- Verify Node still works on 127.0.0.1:3001 (and is firewalled from
  LAN)
- Hit `https://<site-id>.<tailnet>.ts.net` from another Tailscale
  node — should load with valid lock
- Hit from a non-Tailscale device — should fail (Tailscale routes
  unreachable)
- Force a renewal cycle: `step ca renew --force`, verify Caddy picks
  it up
- Kill step-ca for an hour, confirm Caddy keeps serving with the old
  cert and resumes renewal when step-ca comes back

### 10. Rollback path (~0.5 day)

Things that can go wrong and how to recover:

- **Caddy crashes / fails to start** → fall back to plain HTTP via a
  flag in site config (`HTTPS_ENABLED=false`). Site UI continues on
  port 3001. Operator gets paged.
- **step-ca is wedged for >24h** → certs across all sites expire.
  Severe. Mitigation: monitor step-ca uptime; alert at 12h
  unreachable; have a manual fallback to issue long-lived certs from
  the CA private key.
- **Root CA private key compromise** → catastrophic. Every cert ever
  issued is suspect. Procedure: rotate the root, re-issue all
  intermediate + leaf certs, push the new root CA to every device via
  installer update. This is days of work in a worst-case incident.
  Mitigation: keep the root CA private key offline (HSM or
  air-gapped USB), only bring it online to sign new intermediates.
  step-ca supports this workflow.

### 11. Documentation (~0.5 day)

`docs/ops/site-tls.md`:
- Operator runbook for step-ca lifecycle
- Renewal cadence (root: every 10 years, intermediate: yearly,
  automatically by step-ca)
- New-site provisioning steps
- Recovery procedures for the failure modes above
- Monitoring requirements (alerts on step-ca uptime + cert expiry
  warnings 30 days out)

## Phase 2 effort

**5-7 focused engineering days, plus 1-2 weeks of staged rollout
(test VMs → 1 real site → all sites).** Higher risk than Phase 1
because there are more moving parts, but the rollback paths are clean.

---

# Sequencing within the broader roadmap

Three majors are queued:

1. **HTTPS rollout** (this doc)
2. **Hub Postgres migration** (`docs/plans/hub-postgres-migration.md`)
3. **PDF engine migration** (`docs/plans/pdf-engine-migration.md`)

**Don't do them in parallel.** Each is a meaningful surface-area
change. Doing two simultaneously triples the diagnosis cost when
something regresses.

Recommended order:

1. **Phase 1 of HTTPS first** (1-2 days). Smallest, biggest audit win,
   independent of everything else.
2. **Hub Postgres migration** (8-12 days). Decouple before adding
   per-site TLS work — fewer moving parts during the Postgres
   cutover.
3. **Phase 2 of HTTPS** (5-7 days). After Hub is stable on Postgres.
4. **PDF engine migration** (1-2 days). Whenever convenient — this
   one is genuinely small once you sit down to do it; it's just been
   parked because there's no fire.

Total roadmap: ~3-4 weeks of focused engineering, 6-10 weeks of real
elapsed time given normal interleaving with bug fixes and feature work.

# Decisions captured

- **Tailscale ACL**: sites can reach the Hub, sites cannot reach each
  other. Specifically:
  - Allow `tag:site → tag:hub:443` (Caddy reverse proxy)
  - Allow `tag:site → tag:hub:9000` (step-ca ACME endpoint)
  - Deny `tag:site → tag:site:*` (no lateral movement between sites)
  - Allow `tag:operator → *:*` (admin access from operator laptops)
  - Codify this in the Tailscale admin panel's ACL JSON during
    Phase 1 setup.

- **Root CA private key location**: lives on the Hub server alongside
  step-ca itself. Not offline, not in an HSM. This is a deliberate
  trade-off — simpler operation, single backup target, but means a
  Hub compromise compromises the entire CA. Mitigation:
  - Hub server hardened (Windows updates auto-applied, RDP disabled
    or on Tailscale-only, no inbound from internet)
  - Root CA password stored separately from the key file; Hub
    operator types it on step-ca service start (or pulled from a
    sealed env var)
  - Backup: nightly encrypted snapshot of the step-ca data dir to
    secondary storage; lose the Hub disk, restore in an hour
  - Document the rotation procedure if compromise is suspected: bring
    new root CA online, re-bootstrap step-ca, re-issue all certs, push
    new root CA to every site via installer update

- **Cert revocation policy**: don't bother with CRLs. Default 24h
  cert lifetime + step-ca auto-renewal means a decommissioned site's
  cert dies on its own within a day. CRL infrastructure adds
  operational overhead with negligible benefit for our risk profile.

- **Audit ownership**: you are the auditor. No external sign-off
  required. The compliance evidence is "we run TLS application-layer
  on top of WireGuard transport-layer, with cert provenance under our
  control." That meets the bar you're setting.

  Practically this means: no ceremony, no formal compliance
  documentation deliverables — just sound engineering choices written
  down here for posterity. If a third-party audit happens later
  (insurance, customer due diligence), this doc + the operator
  runbooks become the evidence package.

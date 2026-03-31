# Cardoso Windows Installer

## For end users (site installs)

1. Download `CardosoSetup.exe` from the [latest GitHub release](https://github.com/seantunley/Cardoso-App/releases/latest)
2. Right-click → **Run as administrator**
3. Follow the wizard — set port (default 3001) and site name
4. After install, edit `C:\Cardoso Customer App\.env`:
   - Set `SESSION_SECRET` to a random 32+ character string
   - Set `ENCRYPTION_KEY` to a 64-char hex string (run: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   - Set `REPORTING_TOKEN`, `SITE_ID`, `SITE_SLUG`, `SITE_NAME` if this is a hub-connected site
5. Restart the service: `nssm restart CardosoCigarettes`
6. Open browser to `http://localhost:3001`

## Updates

Updates happen **automatically every hour** when a new version is published.

The service checks GitHub Releases, downloads the new version, rebuilds, and restarts itself. No action needed.

Admins can also trigger an update manually from the app's Settings page.

Update logs: `C:\Cardoso Customer App\logs\update.log`

## Service management

```bat
nssm start CardosoCigarettes
nssm stop CardosoCigarettes
nssm restart CardosoCigarettes
nssm status CardosoCigarettes
```

## Uninstall

Use Windows **Add or Remove Programs** → Cardoso Customer Manager.

Your database (`database/cardoso.db`) and `.env` are preserved.

## Building the installer (developers)

Requires: NSIS 3.x, Node.js 22, Git

```bat
npm install
npm run build
:: Download NSSM and Node runtime into windows/build/ (done automatically by GitHub Actions)
makensis windows/installer.nsi
```

The installer is built automatically by GitHub Actions on every push to `main`.

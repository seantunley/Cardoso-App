# Cardoso Cigarettes — Customer Manager

A self-hosted customer management app for Cardoso Cigarettes. Built with React (Vite) + Node.js/Express + SQLite.

---

## Prerequisites

Before you begin, make sure the following are installed on your machine:

- **Node.js** (v18 or later) — https://nodejs.org
- **Python** (v3.x) — required by native Node modules (e.g. `sqlite3`, `better-sqlite3`) — https://www.python.org/downloads/
- **Git** — https://git-scm.com

> **Windows users:** When installing Python, tick **"Add Python to PATH"** during setup. You may also need to run `npm install --global windows-build-tools` from an elevated command prompt if native module compilation fails.

---

## Development Setup

```bash
# 1. Clone the repo
git clone https://github.com/seantunley/Cardoso-App.git
cd Cardoso-App

# 2. Install dependencies
npm install

# 3. Create your .env file from the example
cp .env.example .env
# Then open .env and fill in your values (SESSION_SECRET, DB_PATH, etc.)

# 4. Start the dev server (backend + frontend hot-reload)
npm run dev
```

App runs at: http://localhost:5173

---

## Production Deployment (Windows)

```bash
# 1. Build the frontend
npm run build

# 2. Start the production server (serves API + built frontend)
npm start
```

To run as a Windows service, use the provided NSSM scripts in `scripts/`:
- `install-service.bat` — installs and starts the service
- `update.bat` — pulls latest changes and restarts the service
- `uninstall-service.bat` — removes the service

---

## Default Credentials

On first run, a default admin account is created:

- **Username:** `admin@example.com`
- **Password:** `admin123`

⚠️ Change these immediately after first login.

---

## Environment Variables

See `.env.example` for all required variables.

Key ones:
| Variable | Description |
|---|---|
| `SESSION_SECRET` | Must be at least 32 random characters |
| `DB_PATH` | Path to the SQLite database file (default: `./database/cardoso.db`) |
| `PORT` | Server port (default: `3001`) |
| `NODE_ENV` | Set to `production` for production deployments |

---

## Version

Current version: **v2026.1.1**

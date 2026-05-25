# SAPI — Local AI API Gateway

Local-first dashboard for routing/proxying AI provider APIs. Fork of [9router](https://github.com/) with branding renamed, Tailscale tunnel routes removed, and version-check routes removed.

## Quick install (Windows)

```cmd
git clone https://github.com/thsangyk-oss/sapi.git
cd sapi
setup.cmd
start-sapi.cmd
```

Open http://localhost:20128

## What the scripts do

- `setup.cmd` — runs `npm install`, `npm run build`, copies `public/` and `.next/static/` into `.next/standalone/`, and downloads `bin/cloudflared.exe` (for the Cloudflare tunnel feature; optional).
- `start-sapi.cmd` — launches the standalone server. Reads env vars `PORT` (default 20128), `HOSTNAME` (default 0.0.0.0), `DATA_DIR` (default `%APPDATA%\sapi`).

## Requirements

- Node.js 18+
- Windows (the launcher scripts are `.cmd`). Linux/macOS: `npm install && npm run build && cd .next/standalone && node server.js`.

## Data folder

User data (db, settings, API keys, JWT secret, machine id) lives in `%DATA_DIR%` — default `%APPDATA%\sapi` on Windows.

To migrate data from another machine, copy these files into `%APPDATA%\sapi` (create the folder if missing):
- `db.json`
- `usage.json`
- `requestDetails.json`
- `jwt-secret`
- `machine-id`
- `auth/` folder, if present

None of these are committed to git (see `.gitignore`).

## Manual build (without setup.cmd)

```cmd
npm install
npm run build
xcopy /E /I /Y public .next\standalone\public
xcopy /E /I /Y .next\static .next\standalone\.next\static
:: optionally: download cloudflared.exe into bin\ for tunnel support
:: https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
start-sapi.cmd
```

## Updating

```cmd
git pull
setup.cmd
```

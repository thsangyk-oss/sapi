# SAPI 0.1.0 Portable Windows

## Requirements
- Node.js 18+ installed on the target machine.

## Run
1. Extract this folder.
2. Double-click `start-sapi.cmd`.
3. Open http://localhost:20128

## Data folder
Default data folder: `%APPDATA%\sapi`

To migrate your current data, copy these files from the old machine into `%APPDATA%\sapi` on the new machine:
- `db.json`
- `usage.json`
- `requestDetails.json`
- `jwt-secret`
- `machine-id`
- `auth` folder, if present

You can also set `DATA_DIR` before running to use a custom data folder.

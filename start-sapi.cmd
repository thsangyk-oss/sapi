@echo off
setlocal
if "%PORT%"=="" set PORT=20128
if "%HOSTNAME%"=="" set HOSTNAME=0.0.0.0
if "%DATA_DIR%"=="" set DATA_DIR=%APPDATA%\sapi

cd /d "%~dp0"

if not exist ".next\standalone\server.js" (
  echo [ERROR] Build output not found. Run setup.cmd first.
  pause
  exit /b 1
)

cd ".next\standalone"
node server.js
pause

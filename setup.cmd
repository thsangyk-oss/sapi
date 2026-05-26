@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo === SAPI setup ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org/ first.
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo Node: %%v

echo.
echo [1/4] Installing dependencies (npm install)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  exit /b 1
)

echo.
echo [2/4] Building (next build --webpack)...
set NODE_ENV=production
call .\node_modules\.bin\next build --webpack
if errorlevel 1 (
  echo [ERROR] Build failed.
  exit /b 1
)

echo.
echo [3/4] Copying public assets and static chunks into standalone output...
if not exist ".next\standalone" (
  echo [ERROR] .next\standalone not found - build did not produce standalone output.
  exit /b 1
)
if exist ".next\standalone\public" rmdir /S /Q ".next\standalone\public"
if exist ".next\standalone\.next\static" rmdir /S /Q ".next\standalone\.next\static"
xcopy /E /I /Y "public" ".next\standalone\public" >nul
xcopy /E /I /Y ".next\static" ".next\standalone\.next\static" >nul

echo.
echo [4/4] Downloading cloudflared.exe (optional, for tunnel feature)...
if not exist "bin" mkdir "bin"
if not exist "bin\cloudflared.exe" (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'bin\cloudflared.exe' -UseBasicParsing; Write-Host 'cloudflared downloaded' } catch { Write-Host 'cloudflared download failed (tunnel feature disabled until you place cloudflared.exe in bin\)' }"
) else (
  echo cloudflared.exe already present, skipping download.
)

echo.
echo === Setup complete ===
echo Run: start-sapi.cmd
echo Then open: http://localhost:20128

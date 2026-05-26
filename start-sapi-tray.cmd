@echo off
rem Foreground launcher for the SAPI tray app (useful for debugging the launcher itself).
rem For normal shortcut/auto-start use, point at start-sapi-tray.vbs instead - it has no console window.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sapi-tray.ps1"

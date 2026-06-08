@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-sapi-from-git.ps1" %*
if errorlevel 1 (
  echo.
  echo [ERROR] SAPI update failed.
  pause
  exit /b 1
)
echo.
echo SAPI update complete.
pause

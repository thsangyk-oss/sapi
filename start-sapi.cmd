@echo off
setlocal
set PORT=%PORT%
if "%PORT%"=="" set PORT=20128
set HOSTNAME=%HOSTNAME%
if "%HOSTNAME%"=="" set HOSTNAME=0.0.0.0
if "%DATA_DIR%"=="" set DATA_DIR=%APPDATA%\sapi
cd /d "%~dp0"
node server.js
pause

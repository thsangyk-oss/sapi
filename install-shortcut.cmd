@echo off
rem Install (or remove) Desktop + Start Menu shortcuts for SAPI tray launcher.
rem
rem Usage:
rem   install-shortcut.cmd              install Desktop + Start Menu
rem   install-shortcut.cmd /autostart   also add SAPI to Windows Startup
rem   install-shortcut.cmd /remove      uninstall all SAPI shortcuts
setlocal
cd /d "%~dp0"

set "PS_ARGS="
:parse
if "%~1"=="" goto run
if /I "%~1"=="/remove"    set "PS_ARGS=%PS_ARGS% -Remove"
if /I "%~1"=="--remove"   set "PS_ARGS=%PS_ARGS% -Remove"
if /I "%~1"=="/autostart" set "PS_ARGS=%PS_ARGS% -AutoStart"
if /I "%~1"=="--autostart" set "PS_ARGS=%PS_ARGS% -AutoStart"
if /I "%~1"=="/nodesktop" set "PS_ARGS=%PS_ARGS% -NoDesktop"
shift
goto parse

:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-shortcut.ps1" %PS_ARGS%
endlocal

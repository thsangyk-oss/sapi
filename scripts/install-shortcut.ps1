# Creates Desktop and Start Menu shortcuts for the SAPI tray launcher.
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-shortcut.ps1            # install
#   powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 -Remove    # uninstall
#   powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 -AutoStart # also add to Startup folder

param(
    [switch]$Remove,
    [switch]$AutoStart,
    [switch]$NoDesktop
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$AppRoot   = Split-Path -Parent $ScriptDir
$Target    = Join-Path $AppRoot 'start-sapi-tray.vbs'
$IconPath  = Join-Path $AppRoot 'public\icons\sapi.ico'

$DesktopLnk   = Join-Path ([Environment]::GetFolderPath('Desktop'))   'SAPI.lnk'
$StartMenuDir = Join-Path ([Environment]::GetFolderPath('Programs'))  'SAPI'
$StartMenuLnk = Join-Path $StartMenuDir 'SAPI.lnk'
$StartupLnk   = Join-Path ([Environment]::GetFolderPath('Startup'))   'SAPI.lnk'

function New-Shortcut([string]$Path, [string]$TargetPath, [string]$Icon, [string]$WorkingDir, [string]$Description) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($Path)
    $sc.TargetPath       = 'wscript.exe'
    $sc.Arguments        = '"' + $TargetPath + '"'
    $sc.WorkingDirectory = $WorkingDir
    $sc.IconLocation     = $Icon + ',0'
    $sc.Description      = $Description
    $sc.WindowStyle      = 7   # minimized (wscript ignores anyway, but be explicit)
    $sc.Save()
    Write-Host "  + $Path"
}

if ($Remove) {
    Write-Host 'Removing SAPI shortcuts...'
    foreach ($p in @($DesktopLnk, $StartMenuLnk, $StartupLnk)) {
        if (Test-Path $p) { Remove-Item $p -Force; Write-Host "  - $p" }
    }
    if ((Test-Path $StartMenuDir) -and -not (Get-ChildItem $StartMenuDir -Force)) {
        Remove-Item $StartMenuDir -Force
        Write-Host "  - $StartMenuDir"
    }
    Write-Host 'Done.'
    return
}

if (-not (Test-Path $Target))   { throw "Launcher not found: $Target" }
if (-not (Test-Path $IconPath)) { throw "Icon not found: $IconPath. Run setup again to regenerate." }

Write-Host 'Installing SAPI shortcuts...'
if (-not $NoDesktop) {
    New-Shortcut -Path $DesktopLnk -TargetPath $Target -Icon $IconPath -WorkingDir $AppRoot -Description 'SAPI - local AI API gateway'
}
New-Shortcut -Path $StartMenuLnk -TargetPath $Target -Icon $IconPath -WorkingDir $AppRoot -Description 'SAPI - local AI API gateway'

if ($AutoStart) {
    New-Shortcut -Path $StartupLnk -TargetPath $Target -Icon $IconPath -WorkingDir $AppRoot -Description 'SAPI - starts on login'
    Write-Host 'Auto-start on login: enabled.'
}

Write-Host ''
Write-Host 'Done. Launch SAPI from the Start Menu or Desktop.'
Write-Host 'To remove: install-shortcut.cmd /remove'

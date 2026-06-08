# Updates a local SAPI checkout from git, rebuilds standalone output, and restarts SAPI.

[CmdletBinding()]
param(
    [string]$Repo = "",
    [string]$Branch = "main",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message"
}

function Resolve-RepoPath {
    if ($Repo) {
        return (Resolve-Path -LiteralPath $Repo).Path
    }

    $scriptDir = Split-Path -Parent $MyInvocation.ScriptName
    if ($scriptDir) {
        $candidate = Split-Path -Parent $scriptDir
        if (Test-Path (Join-Path $candidate ".git")) {
            return $candidate
        }
    }

    $defaultRepo = Join-Path $env:APPDATA "sapi\_sapi_src"
    if (Test-Path (Join-Path $defaultRepo ".git")) {
        return $defaultRepo
    }

    throw "SAPI git checkout not found. Pass -Repo C:\path\to\sapi\_sapi_src."
}

function Stop-SapiProcesses([string]$RepoPath) {
    $pidFile = Join-Path $env:APPDATA "sapi\tray.pid"
    if (Test-Path $pidFile) {
        try {
            $oldPid = [int](Get-Content -LiteralPath $pidFile -ErrorAction Stop)
            if ($oldPid -gt 0) {
                Write-Host "Stopping SAPI pid $oldPid from tray.pid"
                & taskkill.exe /PID $oldPid /T /F 2>$null | Out-Null
            }
        } catch {
            Write-Host "Could not stop pid from tray.pid: $($_.Exception.Message)"
        }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }

    $escapedRepo = [regex]::Escape($RepoPath)
    $currentPid = $PID
    $targets = Get-CimInstance Win32_Process |
        Where-Object {
            $_.ProcessId -ne $currentPid -and
            $_.CommandLine -and
            (
                $_.CommandLine -match "$escapedRepo.*\.next\\standalone\\server\.js" -or
                $_.CommandLine -match "$escapedRepo.*scripts\\sapi-tray\.ps1"
            )
        }

    foreach ($proc in $targets) {
        Write-Host "Stopping SAPI process $($proc.ProcessId)"
        try { & taskkill.exe /PID $proc.ProcessId /T /F 2>$null | Out-Null } catch {}
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$File,

        [string[]]$CommandArgs = @(),

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Write-Host ("> {0} {1}" -f $File, ($CommandArgs -join " "))
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $File @CommandArgs
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        throw "$File exited with code $exitCode"
    }
}

$repoPath = Resolve-RepoPath
Write-Step "Using repo: $repoPath"

if (-not (Test-Path (Join-Path $repoPath ".git"))) {
    throw "Not a git checkout: $repoPath"
}

Write-Step "Stopping running SAPI"
Stop-SapiProcesses -RepoPath $repoPath

Write-Step "Checking local git state"
$dirty = git -C $repoPath status --porcelain
if ($dirty) {
    Write-Host $dirty
    throw "Working tree has local changes. Commit/stash them before updating."
}

Write-Step "Pulling latest code"
Invoke-Checked -File "git" -CommandArgs @("-C", $repoPath, "fetch", "origin", $Branch, "--prune") -WorkingDirectory $repoPath
Invoke-Checked -File "git" -CommandArgs @("-C", $repoPath, "checkout", $Branch) -WorkingDirectory $repoPath
Invoke-Checked -File "git" -CommandArgs @("-C", $repoPath, "pull", "--ff-only", "origin", $Branch) -WorkingDirectory $repoPath

Write-Step "Installing dependencies"
Invoke-Checked -File "npm.cmd" -CommandArgs @("install") -WorkingDirectory $repoPath

Write-Step "Building standalone app"
$env:NODE_ENV = "production"
$nextCmd = Join-Path $repoPath "node_modules\.bin\next.cmd"
if (-not (Test-Path $nextCmd)) {
    throw "next.cmd not found after npm install: $nextCmd"
}
Invoke-Checked -File $nextCmd -CommandArgs @("build", "--webpack") -WorkingDirectory $repoPath

$standalone = Join-Path $repoPath ".next\standalone"
if (-not (Test-Path (Join-Path $standalone "server.js"))) {
    throw "Build did not produce .next\standalone\server.js"
}

Write-Step "Copying public assets and static chunks"
$publicSrc = Join-Path $repoPath "public"
$publicDest = Join-Path $standalone "public"
if (-not (Test-Path $publicDest)) {
    New-Item -ItemType Directory -Path $publicDest -Force | Out-Null
}
Copy-Item -Path (Join-Path $publicSrc "*") -Destination $publicDest -Recurse -Force

$staticSrc = Join-Path $repoPath ".next\static"
$staticDest = Join-Path $standalone ".next\static"
if (-not (Test-Path $staticDest)) {
    New-Item -ItemType Directory -Path $staticDest -Force | Out-Null
}
Copy-Item -Path (Join-Path $staticSrc "*") -Destination $staticDest -Recurse -Force

if (-not $NoStart) {
    Write-Step "Starting SAPI tray"
    $vbs = Join-Path $repoPath "start-sapi-tray.vbs"
    if (Test-Path $vbs) {
        Start-Process -FilePath "wscript.exe" -ArgumentList @("`"$vbs`"") -WorkingDirectory $repoPath -WindowStyle Hidden
    } else {
        $serverJs = Join-Path $standalone "server.js"
        $env:PORT = if ($env:PORT) { $env:PORT } else { "20128" }
        $env:HOSTNAME = if ($env:HOSTNAME) { $env:HOSTNAME } else { "0.0.0.0" }
        $env:DATA_DIR = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $env:APPDATA "sapi" }
        Start-Process -FilePath "node.exe" -ArgumentList @("`"$serverJs`"") -WorkingDirectory $standalone -WindowStyle Hidden
    }

    Start-Sleep -Seconds 4
    $port = if ($env:PORT) { $env:PORT } else { "20128" }
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 10
        Write-Host "Health: $($health | ConvertTo-Json -Compress)"
    } catch {
        Write-Host "SAPI was started, but health check did not respond yet: $($_.Exception.Message)"
    }
}

Write-Step "Done"

# SAPI System Tray Launcher
# Runs the SAPI Next.js server in the background and shows a tray icon
# with Open / Restart / Quit actions.

[System.Threading.Thread]::CurrentThread.ApartmentState | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

# --- Resolve paths --------------------------------------------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$AppRoot     = Split-Path -Parent $ScriptDir
$StandaloneDir = Join-Path $AppRoot '.next\standalone'
$ServerJs    = Join-Path $StandaloneDir 'server.js'
$IconPng     = Join-Path $AppRoot 'public\icons\icon-192.png'
$IconIco     = Join-Path $AppRoot 'public\icons\sapi.ico'
$LogDir      = Join-Path $env:APPDATA 'sapi\logs'
$LogFile     = Join-Path $LogDir 'tray.log'
$PidFile     = Join-Path $env:APPDATA 'sapi\tray.pid'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log([string]$Msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Msg
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch {}
}

# --- Job Object (kills child processes when this process dies) ------------
# Without this, force-killing the tray (Task Manager, logout) would orphan node.
if (-not ('SapiJob' -as [type])) {
    Add-Type -Namespace SapiTray -Name JobNative -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetInformationJobObject(IntPtr hJob, int InfoClass, IntPtr lpInfo, uint cbInfoLength);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(IntPtr hObject);
'@
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SapiJob {
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public Int64 Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK     = 0x0800;
    public const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
}
'@
}

$script:JobHandle = [SapiTray.JobNative]::CreateJobObject([IntPtr]::Zero, $null)
if ($script:JobHandle -ne [IntPtr]::Zero) {
    $info = New-Object SapiJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $info.BasicLimitInformation.LimitFlags = [SapiJob]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]([SapiJob+JOBOBJECT_EXTENDED_LIMIT_INFORMATION]))
    $ptr  = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    try {
        [System.Runtime.InteropServices.Marshal]::StructureToPtr($info, $ptr, $false)
        $okSet = [SapiTray.JobNative]::SetInformationJobObject($script:JobHandle, [SapiJob]::JobObjectExtendedLimitInformation, $ptr, [uint32]$size)
        if (-not $okSet) { Write-Log "SetInformationJobObject failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
    }
    Write-Log "Created Job handle=$($script:JobHandle.ToInt64())"
} else {
    Write-Log "CreateJobObject failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    $script:JobHandle = $null
}

# --- Single-instance guard via mutex --------------------------------------
$mutexName = 'Global\SAPI_Tray_Mutex_v1'
$mutexCreated = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$mutexCreated)
if (-not $mutexCreated) {
    [System.Windows.Forms.MessageBox]::Show('SAPI tray is already running.', 'SAPI', 'OK', 'Information') | Out-Null
    exit 0
}

# --- Configuration --------------------------------------------------------
if (-not $env:PORT)     { $env:PORT     = '20128' }
if (-not $env:HOSTNAME) { $env:HOSTNAME = '0.0.0.0' }
if (-not $env:DATA_DIR) { $env:DATA_DIR = Join-Path $env:APPDATA 'sapi' }
$OpenUrl = "http://localhost:$($env:PORT)"

# --- Icon -----------------------------------------------------------------
function Get-TrayIcon {
    if (Test-Path $IconIco) {
        try { return New-Object System.Drawing.Icon($IconIco) } catch {}
    }
    if (Test-Path $IconPng) {
        try {
            $bmp = [System.Drawing.Bitmap]::FromFile($IconPng)
            $hicon = $bmp.GetHicon()
            return [System.Drawing.Icon]::FromHandle($hicon)
        } catch {}
    }
    return [System.Drawing.SystemIcons]::Application
}

# --- Reap orphaned node from previous abnormal exit ----------------------
function Invoke-OrphanReaper {
    if (-not (Test-Path $PidFile)) { return }
    $oldPid = $null
    try { $oldPid = [int](Get-Content $PidFile -ErrorAction Stop) } catch {}
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    if (-not $oldPid) { return }
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if (-not $proc) { return }
    if ($proc.ProcessName -ne 'node') {
        Write-Log "Stale pidfile pointed at pid=$oldPid (proc=$($proc.ProcessName)), skipping reap"
        return
    }
    Write-Log "Reaping orphaned node pid=$oldPid from previous session"
    try { & taskkill.exe /PID $oldPid /T /F 2>$null | Out-Null } catch {}
}
Invoke-OrphanReaper

# --- Server process management -------------------------------------------
$script:Server = $null

function Start-Server {
    if (-not (Test-Path $ServerJs)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Build output not found:`n$ServerJs`n`nRun setup.cmd first.",
            'SAPI', 'OK', 'Error') | Out-Null
        Write-Log "server.js not found at $ServerJs"
        return $false
    }

    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) {
        [System.Windows.Forms.MessageBox]::Show(
            'Node.js was not found in PATH. Install Node 18+ from https://nodejs.org/',
            'SAPI', 'OK', 'Error') | Out-Null
        Write-Log 'node.exe not found in PATH'
        return $false
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName        = $node.Source
    $psi.Arguments       = '"' + $ServerJs + '"'
    $psi.WorkingDirectory = $StandaloneDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow  = $true
    foreach ($k in @('PORT','HOSTNAME','DATA_DIR','NODE_ENV')) {
        $val = [Environment]::GetEnvironmentVariable($k)
        if ($val) { $psi.EnvironmentVariables[$k] = $val }
    }
    if (-not $psi.EnvironmentVariables.ContainsKey('NODE_ENV')) {
        $psi.EnvironmentVariables['NODE_ENV'] = 'production'
    }

    try {
        $script:Server = [System.Diagnostics.Process]::Start($psi)
        $script:Server.EnableRaisingEvents = $true
        Set-Content -Path $PidFile -Value $script:Server.Id -Encoding ascii
        Write-Log "Started node pid=$($script:Server.Id)"
        if ($script:JobHandle) {
            $assigned = [SapiTray.JobNative]::AssignProcessToJobObject($script:JobHandle, $script:Server.Handle)
            if ($assigned) { Write-Log "AssignProcessToJobObject OK" }
            else            { Write-Log "AssignProcessToJobObject FAILED err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
        } else {
            Write-Log "No JobHandle - child not protected against orphaning"
        }
        return $true
    } catch {
        Write-Log "Failed to start node: $_"
        [System.Windows.Forms.MessageBox]::Show("Failed to start SAPI:`n$_", 'SAPI', 'OK', 'Error') | Out-Null
        return $false
    }
}

function Stop-Server {
    if ($script:Server -and -not $script:Server.HasExited) {
        try {
            Write-Log "Stopping node pid=$($script:Server.Id)"
            # Kill the whole tree because Next can spawn children
            & taskkill.exe /PID $script:Server.Id /T /F 2>$null | Out-Null
        } catch { Write-Log "Stop-Server error: $_" }
    }
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
    $script:Server = $null
}

function Restart-Server {
    Stop-Server
    Start-Sleep -Milliseconds 500
    [void](Start-Server)
}

function Open-Sapi {
    Start-Process $OpenUrl
}

# --- Build tray UI --------------------------------------------------------
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = Get-TrayIcon
$notify.Text = "SAPI - $OpenUrl"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add("Open SAPI  ($OpenUrl)")
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.add_Click({ Open-Sapi })

$miRestart = $menu.Items.Add("Restart server")
$miRestart.add_Click({ Restart-Server; $notify.ShowBalloonTip(2000, 'SAPI', 'Server restarted', 'Info') })

$miStatus = $menu.Items.Add("Show status")
$miStatus.add_Click({
    $running = $script:Server -and -not $script:Server.HasExited
    $msg = if ($running) { "Running (pid=$($script:Server.Id)) on $OpenUrl" } else { 'Not running' }
    [System.Windows.Forms.MessageBox]::Show($msg, 'SAPI', 'OK', 'Information') | Out-Null
})

$miLogs = $menu.Items.Add("Open log folder")
$miLogs.add_Click({ Start-Process explorer.exe $LogDir })

[void]$menu.Items.Add('-')

$miQuit = $menu.Items.Add("Quit SAPI")
$miQuit.add_Click({
    Write-Log 'Quit requested via tray'
    $notify.Visible = $false
    Stop-Server
    [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_DoubleClick({ Open-Sapi })

# --- Start server and show balloon ----------------------------------------
if (Start-Server) {
    $notify.ShowBalloonTip(2500, 'SAPI', "Running at $OpenUrl", 'Info')
} else {
    $notify.ShowBalloonTip(3000, 'SAPI', 'Failed to start server. See tray log.', 'Error')
}

# --- Cleanup on exit ------------------------------------------------------
$cleanup = {
    try { Stop-Server } catch {}
    try { $notify.Visible = $false; $notify.Dispose() } catch {}
    try { if ($script:JobHandle) { [SapiTray.JobNative]::CloseHandle($script:JobHandle) | Out-Null; $script:JobHandle = $null } } catch {}
    try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch {}
}
Register-EngineEvent PowerShell.Exiting -Action $cleanup | Out-Null
[System.Windows.Forms.Application]::add_ApplicationExit($cleanup)

Write-Log 'Entering message loop'
[System.Windows.Forms.Application]::Run()
& $cleanup

' Launches the SAPI tray launcher silently (no console window flicker).
' Use this for shortcut targets; use start-sapi-tray.cmd for foreground debugging.

Option Explicit

Dim shell, fso, scriptDir, ps1Path
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path   = scriptDir & "\scripts\sapi-tray.ps1"

If Not fso.FileExists(ps1Path) Then
    MsgBox "Cannot find sapi-tray.ps1 at: " & ps1Path, vbCritical, "SAPI"
    WScript.Quit 1
End If

' 0 = hidden window, False = don't wait
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Path & """", 0, False

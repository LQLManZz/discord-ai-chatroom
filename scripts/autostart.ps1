# Start AIAgentBot (and through it, onWatch) automatically at Windows logon, with no console window.
#   powershell -File scripts\autostart.ps1            -> install / update
#   powershell -File scripts\autostart.ps1 -Remove    -> uninstall
param([switch]$Remove)

$name = 'AIAgentBot'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$name'."
  return
}

$runner = Join-Path $PSScriptRoot 'run-bot.cmd'
# conhost --headless runs the console script without showing a window
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless cmd.exe /c `"$runner`"" -WorkingDirectory (Split-Path $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description 'AIAgentBot Discord hub (keeps onWatch running too)' -Force | Out-Null
Write-Host "Installed scheduled task '$name' (runs at logon). Start now: Start-ScheduledTask $name"

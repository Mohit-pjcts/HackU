# Backstage: start the Windows engine (run from a normal, non-admin PowerShell).
#   powershell -ExecutionPolicy Bypass -File start.ps1
# On macOS use:  bash start.sh
& (Join-Path $PSScriptRoot "windows\scripts\start.ps1") @args

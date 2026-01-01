Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

& (Join-Path $here 'kill-port.ps1') -Ports 5173,4173

Write-Host '[dev-reset] starting dev server...'
Set-Location (Resolve-Path (Join-Path $here '..'))
npm run dev

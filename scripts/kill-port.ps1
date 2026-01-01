param(
  [Parameter(Mandatory = $true)]
  [int[]]$Ports
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($port in $Ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $connections) {
    Write-Host "[kill-port] ${port}: no listener"
    continue
  }

  foreach ($conn in $connections) {
    $procId = $conn.OwningProcess
    if (-not $procId -or $procId -le 0) { continue }

    try {
      $proc = Get-Process -Id $procId -ErrorAction Stop
      Write-Host "[kill-port] ${port}: stopping PID=$procId ($($proc.ProcessName))"
      Stop-Process -Id $procId -Force
    } catch {
      Write-Host "[kill-port] ${port}: failed to stop PID=$procId ($($_.Exception.Message))"
    }
  }
}

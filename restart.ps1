# Restart the local Agent Chess server: build the UI, stop the running server (asking it first, so it saves
# everything), start a new one in the background and wait until it answers. Safe to run at any time, by anyone:
#   pwsh -NoProfile -File C:\Users\User\agent-chess\restart.ps1
# Its output goes to data-server.log / data-server.err and its process id to .server.pid. Agents ride out the
# restart on their own. start.ps1 runs the server in the foreground instead.
# -Port, -DataDir and -LogDir point it at a spare server (for testing); -NoBuild skips the UI build.
param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 5170 }),
  [string]$DataDir = $(if ($env:AGENT_CHESS_DATA) { $env:AGENT_CHESS_DATA } else { Join-Path $PSScriptRoot 'data' }),
  [string]$LogDir = $PSScriptRoot,
  [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Get-Listener {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $c.OwningProcess } else { $null }
}
function Wait-Gone([int]$ProcessId, [int]$Seconds) {
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# 1. Build first: a failed build leaves the running server alone.
if (-not $NoBuild) {
  Write-Host 'Building the UI...'
  & npx vite build
  if ($LASTEXITCODE -ne 0) { Write-Host 'The UI build failed: the running server was left as it is.'; exit 1 }
}

# 2. Stop the server on our port, and only that: other node servers run on this machine.
$old = Get-Listener
if ($old) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$old"
  if ($proc.CommandLine -notmatch 'server[\\/]index\.ts') {
    Write-Host "Port $Port is held by something that isn't the Agent Chess server (process $old): $($proc.CommandLine). Not touching it."
    exit 1
  }
  # Started through tsx, the server runs under a small wrapper process that goes with it.
  $wrapper = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue
  if ($wrapper -and $wrapper.CommandLine -notmatch 'tsx[\\/]dist[\\/]cli\.mjs') { $wrapper = $null }
  $asked = $false
  try {
    $token = (Get-Content (Join-Path $DataDir 'admin-token.txt') -Raw).Trim()
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/admin/shutdown" -Headers @{ 'x-admin-token' = $token } -TimeoutSec 10 | Out-Null
    $asked = $true
    Write-Host "Asked the server (process $old) to stop."
  } catch {
    Write-Host "Couldn't ask the server to stop ($($_.Exception.Message))."
  }
  if (-not ($asked -and (Wait-Gone $old 20))) {
    Write-Host "Stopping process $old."
    Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
    Wait-Gone $old 10 | Out-Null
  }
  if ($wrapper -and -not (Wait-Gone $wrapper.ProcessId 5)) { Stop-Process -Id $wrapper.ProcessId -Force -ErrorAction SilentlyContinue }
  $until = (Get-Date).AddSeconds(10)
  while ((Get-Listener) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 250 }
  if (Get-Listener) { Write-Host "Port $Port is still in use: not starting a second server."; exit 1 }
}

# 3. Start the new one, hidden and outliving this script.
$out = Join-Path $LogDir 'data-server.log'
$err = Join-Path $LogDir 'data-server.err'
$env:PORT = "$Port"
$env:AGENT_CHESS_DATA = $DataDir
$node = (Get-Command node).Source
$p = Start-Process -FilePath $node -ArgumentList 'node_modules/tsx/dist/cli.mjs', 'server/index.ts' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

# 4. Wait until it answers.
$until = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $until) {
  if ($p.HasExited) { Write-Host "The server stopped while starting: see $err"; exit 1 }
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/meta" -UseBasicParsing -TimeoutSec 5 | Out-Null
    $listener = Get-Listener
    Set-Content -Path (Join-Path $LogDir '.server.pid') -Value $listener -Encoding ascii
    Write-Host "Agent Chess is up on http://127.0.0.1:$Port (process $listener, under wrapper $($p.Id)). Logs: $out, $err"
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
Write-Host "The server didn't answer within 2 minutes: see $err"
exit 1

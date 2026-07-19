# Detached data-collection loop for the observer strategy.
#
# Runs `bun run index.ts --strategy observer --rounds <remaining> --always-log`
# until logs/ contains at least $target resolved market logs, restarting the
# engine if it crashes. Completed rounds are counted by market log files —
# the engine only flushes a market log when a round completes, so the file
# count equals the number of finished rounds.
#
# Stop early by creating the file research\STOP (checked between restarts),
# or by killing the bun process (PID in state\early-bird.lock).
#
# Launch (detached, survives the launching terminal):
#   Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','research\collector.ps1' -WorkingDirectory 'C:\Users\rocis\poly' -WindowStyle Hidden

$ErrorActionPreference = 'Continue'
Set-Location 'C:\Users\rocis\poly'

$target = 300
if ($env:COLLECT_TARGET) { $target = [int]$env:COLLECT_TARGET }

$bun = (Get-Command bun).Source
$out = 'research\collector-output.log'

function Get-CompletedRounds {
    try {
        return (Get-ChildItem 'logs' -Filter 'early-bird-btc-updown-5m-*.log' -ErrorAction Stop | Measure-Object).Count
    } catch {
        return 0
    }
}

Add-Content $out "`n[$(Get-Date -Format o)] collector: starting, target = $target rounds"

while ($true) {
    if (Test-Path 'research\STOP') {
        Add-Content $out "[$(Get-Date -Format o)] collector: STOP file found, exiting"
        break
    }

    $count = Get-CompletedRounds
    if ($count -ge $target) {
        Add-Content $out "[$(Get-Date -Format o)] collector: $count/$target rounds collected, done"
        break
    }

    $remaining = $target - $count
    Add-Content $out "[$(Get-Date -Format o)] collector: $count/$target collected, launching engine for $remaining round(s)"

    # Blocks until the engine exits (all rounds done, crash, or kill).
    & $bun run index.ts --strategy observer --rounds $remaining --always-log *>> $out

    Add-Content $out "[$(Get-Date -Format o)] collector: engine exited (code $LASTEXITCODE), restarting in 30s"
    Start-Sleep -Seconds 30
}

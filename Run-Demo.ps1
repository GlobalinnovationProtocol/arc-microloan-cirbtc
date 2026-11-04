# Starts a local Hardhat node, runs the Arc micro-loan demo for one outcome, then stops the node.
#   .\Run-Demo.ps1            -> outcome 1 (borrower repays on time)
#   .\Run-Demo.ps1 2          -> default, sale in deficit (house pays via payDeficit)
#   .\Run-Demo.ps1 3          -> default, sale with excess (house keeps it)
# Everything shown is the production code from src/ and contracts/ running on a local chain; no keys, no real funds.
param([ValidateSet('1', '2', '3')][string]$Outcome = '1', [string]$Deposits = 'y,y')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Start-Process -FilePath 'node' -ArgumentList '.\node_modules\hardhat\internal\cli\bootstrap.js', 'node', '--port', '8545' -PassThru -WindowStyle Minimized
try {
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-NetConnection 127.0.0.1 -Port 8545 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
        if ((Get-Date) -gt $deadline) { throw 'Hardhat node did not start within 60 s' }
        Start-Sleep -Seconds 1
    }
    $env:DEMO_ACCEPT_TERMS = '1'; $env:DEMO_LENDER_DEPOSITS = $Deposits; $env:DEMO_CHOICE = $Outcome
    node .\poc\arc-demo.js
    if ($LASTEXITCODE -ne 0) { throw "Demo stopped with exit code $LASTEXITCODE. Read the error above." }
}
finally {
    if ($node -and -not $node.HasExited) { Stop-Process -Id $node.Id -Force }
}

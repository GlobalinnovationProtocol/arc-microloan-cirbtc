# Runs ONE loan outcome on Arc Testnet with REAL transactions and prints an explorer link per step,
# while saving the full terminal output to deploy\recording-<outcome>.txt (useful alongside a screen recording).
#   .\Record-Testnet-Demo.ps1 1    -> on-time repayment (reusable: collateral comes back to the borrower)
#   .\Record-Testnet-Demo.ps1 2    -> default, sale -80 % (deficit paid by the house)   [consumes the cirBTC]
#   .\Record-Testnet-Demo.ps1 3    -> default, sale +10 % (excess kept by the house)    [consumes the cirBTC]
# Needs: deploy\arc-testnet.json (from scripts\deploy-arc-testnet.js) and the testnet deployer key in
#   $env:USERPROFILE\.arc-testnet\deployer.key  (testnet only). Fund it at https://faucet.circle.com (Arc Testnet):
#   USDC for gas and cirBTC (0.0001 per faucet request = enough for 3 outcome-1 runs or 1 default run).
param([ValidateSet('1', '2', '3')][string]$Outcome = '1', [string]$PrincipalUsdc = '0.5')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$keyFile = Join-Path $env:USERPROFILE '.arc-testnet\deployer.key'
if (-not (Test-Path $keyFile)) { throw "missing $keyFile - see deploy\ARC-TESTNET.md step 1" }
$env:DEPLOYER_PRIVATE_KEY = (Get-Content $keyFile -Raw).Trim()
$env:DEMO_CHOICE = $Outcome
$env:DEMO_PRINCIPAL_USDC = $PrincipalUsdc
$log = "deploy\recording-$Outcome.txt"
Write-Host "== Arc Testnet (chain 5042002) - outcome $Outcome - explorer https://explorer.testnet.arc.io ==" -ForegroundColor Cyan
node .\poc\arc-testnet-demo.js 2>&1 | Tee-Object -FilePath $log
if ($LASTEXITCODE -ne 0) { throw "Demo stopped with exit code $LASTEXITCODE. Read the error above (most often: not enough cirBTC or gas on the deployer)." }
Write-Host "saved $log" -ForegroundColor Green

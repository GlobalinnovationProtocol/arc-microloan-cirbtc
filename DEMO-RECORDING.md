# Recording the demo for Circle (terminal only, ~6 minutes)

## Setup once (PowerShell, in this folder)
```powershell
npm install
npx hardhat compile
npm test                       # 29 pass, 4 live checks skipped
npm run test:contract          # 6 passing
```

## Record (Windows: Win+Alt+R starts/stops Xbox Game Bar recording; or OBS)
Open PowerShell in this folder, make the font large (Ctrl + mouse wheel), then run the three outcomes one after the other:
```powershell
.\Run-Demo.ps1 1     # borrower repays on time: lender paid + collateral returned atomically
.\Run-Demo.ps1 2     # default, cirBTC sold -80%: lender made whole, house pays the deficit (payDeficit)
.\Run-Demo.ps1 3     # default, cirBTC sold +10%: lender made whole, house keeps the excess
```
Each run deploys mock USDC, mock cirBTC (8 decimals), a mock DEX router and the real `LoanEscrow` on a local Hardhat chain,
then shows every transaction as `[VERIFIED]` with block number and hash, and ends with on-chain re-read checks (`[OK]`).

## What to say while it runs (30 seconds per point)
1. Product: 1000 USDC fixed loans, 42 days, 2.5 % fee, 12 %/yr, 25 % LTV, collateral = cirBTC only, KYC on both sides, FIFO lenders.
2. Non-custodial: the server only returns unsigned calldata; `LoanEscrow` (221 lines, immutable, no admin) holds collateral.
3. `settle()` is permissionless and sells through a DEX with a minimum-output floor; a shortfall is recorded and paid by the house manually (`payDeficit`).
4. Arc-native: USDC `0x3600…0000` for gas and loans, cirBTC `0x171A…bAA0` (mainnet) verified on-chain; the server refuses to start if the token address has no code.
5. Honest limits: no DEX router or price oracle is published for Arc yet (demo uses a fixed price and a mock router); external audit pending; `cancel()` limitation disclosed.

## Optional: real Arc Testnet transactions (needs a funded test key, see deploy/ARC-TESTNET.md)
One command per outcome, with an explorer link per step and the output saved to `deploy\recording-<n>.txt`:
```powershell
.\Record-Testnet-Demo.ps1 1     # repayment (re-runnable: the cirBTC comes back to the borrower)
.\Record-Testnet-Demo.ps1 2     # default with deficit   (consumes 0.000033 cirBTC)
.\Record-Testnet-Demo.ps1 3     # default with excess    (consumes 0.000033 cirBTC)
```
Before recording, top up the deployer `0x729FA5cfaFc9F4036E97C1464922947Eb33443D0` at https://faucet.circle.com
(Arc Testnet): USDC for gas and cirBTC (0.0001 per request). Manual equivalent:
```powershell
$env:DEPLOYER_PRIVATE_KEY = (Get-Content "$env:USERPROFILE\.arc-testnet\deployer.key" -Raw).Trim()
$env:DEMO_CHOICE = "1"; $env:DEMO_PRINCIPAL_USDC = "0.5"; node poc/arc-testnet-demo.js
```
Every line then carries a https://explorer.testnet.arc.io/tx/... link Circle can open.

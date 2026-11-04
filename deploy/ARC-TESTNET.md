# Arc Testnet POC - deploy and run real transactions (point 1 of the grant/audit readiness plan)

Network: Arc Testnet, chain ID 5042002, RPC `https://rpc.testnet.arc.io`, explorer `https://explorer.testnet.arc.io`,
gas = USDC (faucet: https://faucet.circle.com, select Arc Testnet). Real testnet USDC `0x3600000000000000000000000000000000000000`,
real testnet cirBTC `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF` (8 decimals). Mainnet cirBTC: `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`.

## 1. Deployer key (testnet only, never reuse on mainnet)

```bash
node -e "const {Wallet}=require('ethers');const w=Wallet.createRandom();console.log('ADDRESS',w.address);console.log('KEY',w.privateKey)"
```
Fund ADDRESS at https://faucet.circle.com (Arc Testnet, USDC). Repeat the faucet 2-3 times: gas + demo funding needs ~5-10 USDC.

## 2. Deploy

```bash
cd D-kyc-audit-I && npm install
export DEPLOYER_PRIVATE_KEY=0x...        # PowerShell: $env:DEPLOYER_PRIVATE_KEY="0x..."
npx hardhat compile
npx hardhat run --network arcTestnet scripts/deploy-arc-testnet.js
```
Deploys `LoanEscrow` (real USDC, mock router) and a mock 8-decimal cirBTC (default). Set `USE_REAL_CIRBTC=1` to point the
escrow at the real testnet cirBTC instead; the borrower account must then hold some cirBTC (no public cirBTC faucet).
Addresses and deployment tx hashes go to `deploy/arc-testnet.json`.

## 3. Run the three outcomes (each ~3 minutes, real time)

```bash
DEMO_CHOICE=1 node poc/arc-testnet-demo.js    # on-time repayment
DEMO_CHOICE=2 node poc/arc-testnet-demo.js    # default, sale in deficit -> house pays via payDeficit()
DEMO_CHOICE=3 node poc/arc-testnet-demo.js    # default, sale with excess -> house keeps it
```
Each run prints every transaction with its explorer link and re-reads the final state on-chain; results are saved to
`deploy/arc-testnet-demo-<choice>.json`. Attach those three files plus `deploy/arc-testnet.json` to the grant / audit package.

Scaling: `DEMO_PRINCIPAL_USDC` (default 1) replaces the production 1000 USDC so faucet amounts suffice; the ratios
(2.5 % fee, 12 %/yr over 42 days, 25 % LTV) are the production ones. `DEMO_CIRBTC_PRICE` (default 60000) is the fixed demo price.

## What this POC proves / does not prove

Proves: the audited `LoanEscrow` bytecode deploys and runs on Arc with real USDC; `lock` / `repay` / `settle` / `payDeficit`
behave as specified; the server-side `verifyCollateralLock()` binds the on-chain `Locked` event to the loan.

Does not prove: price-feed and DEX integration (no oracle or router is published for Arc yet; the demo uses a fixed price and
`MockDexRouter`), cirBTC issuer behaviour under pause/blocklist, and economics at the 1000 USDC scale.

## Verify the cirBTC addresses yourself

```bash
curl -s -X POST -H "content-type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x171A4217b86A807A64eB94757Db6849fb4bDbAA0","data":"0x313ce567"},"latest"]}' https://rpc.mainnet.arc.io
```
Expected result ends in `...08` (8 decimals). Same call with `0x95d89b41` returns the symbol `cirBTC`.

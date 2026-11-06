# Arc Micro-Loan (D-kyc) — White Paper

Status: proof of concept configured for Arc Mainnet network metadata. Production deployment is not enabled: collateral contracts, DEX routing, live price sources, and the escrow deployment address remain unconfigured. Not legal advice; licensing and the choice of KYC provider are out of scope.

## 1. Product

| Item | Value |
|---|---|
| Loan | One tranche, exactly 1000 USDC |
| Term | One fixed term of 6 weeks (42 days); no extension |
| Issuance fee | 2.5 % of principal (25 USDC), paid by the borrower to the house |
| Interest | 12 % per year, prorated over 42 days (13.808219 USDC on 1000) |
| Collateral | cirBTC only (Circle's natively issued bitcoin token on Arc) — loan-to-value 25 % |
| **KYC** | **Required for every lender (FIFO queue) and every borrower** |
| Lender order | FIFO by on-chain USDC approval to the escrow, among KYC-approved lenders whose live allowance **and** balance cover 1000 USDC; others are skipped |
| Capacity | At most 300 confirmed loans per rolling 24 h (the 301st request gets 503) |
| Chain | Arc (Circle's EVM-compatible L1, USDC-native gas) |

One deployed `LoanEscrow` contract, one audit. The collateral token is a per-loan parameter passed to `lock()`, but this deployment allowlists exactly one: cirBTC, issued natively by Circle on Arc with Circle's 2026 tooling (an ERC-20 on Arc, whose gas is USDC). Third-party wrapped assets (wXRP, wETH, wBTC, wcbBTC, solvBTC) are no longer accepted; their bridge/custodian risk is removed from the product.

## 2. KYC design

- Identity checks are done by an **external KYC provider**. This server never receives, stores or processes identity documents or personal data.
- The provider's output is a plain list of approved EVM addresses, loaded from a file (`KYC_FILE`, default `kyc-approved.txt`, one address per line, `#` for comments). Invalid lines are ignored.
- `/loan/request` returns **403** unless **both** the lender and the borrower address are on the list.
- The FIFO queue refuses to enqueue a lender that is not approved, so FIFO order is kept among approved lenders only.
- The server refuses to start without a KYC registry.
- Because KYC is applied, the geo restriction and the identity rules for loans of 1,000 USD or more depend on the legal opinion for each jurisdiction. This paper does not decide them.

## 3. Design decision: on-chain settle() instead of a custodial fee wallet

XRPL has no native escrow analogue that can itself inspect a price and sell collateral, so the sibling XRPL build (H-kyc) must route default settlement through an operator-controlled fee wallet that is transiently permitted to submit the sale. Arc's EVM lets the contract do the whole job itself:

- A single, immutable, non-upgradeable `LoanEscrow` contract (`contracts/LoanEscrow.sol`) holds each loan's collateral from `lock()` until `repay()` or `settle()`.
- `settle(loanId)` is **permissionless**: once a loan's `finishAfter` has passed, anyone — a keeper bot, the lender, a public cron job — can call it, paying only their own gas. If the borrower already repaid, nothing is left to settle. Otherwise the contract swaps the collateral for USDC through a DEX router with an `amountOutMinimum` floor, pays the lender principal + interest directly from the swap output, forwards any excess to the house, and — if the swap output falls short — pays the lender everything available and records the shortfall in `deficits[loanId]`.
- `payDeficit(loanId)` is restricted to the house address. This is the one deliberately manual, human-in-the-loop step: the house reviews the recorded shortfall and triggers payment from its own wallet whenever it chooses.
- `repay(loanId)` is atomic: it pays the lender principal + interest and returns the collateral to the borrower in a single transaction, so there is no window where one leg has happened and the other has not.
- The result is **more non-custodial than the XRPL build**: there, the fee wallet still transiently holds sale proceeds mid-flight; here, nothing but the audited contract itself ever touches loan funds in the common path. No operator key ever has custody.

## 4. Flow

1. Borrower and lender addresses, plus the borrower's chosen collateral symbol, are submitted to `/loan/request`. Secrets (seeds, private keys, mnemonics) are rejected on every route; a request that would legitimately carry a 64-hex-character transaction hash (`/loan/confirm`) is exempted from the private-key-shaped check, since EVM private keys and transaction hashes share that same shape.
2. Both addresses must be KYC-approved, and the collateral symbol must be `cirBTC` (the only configured token; it is also the default when omitted).
3. Time and price come from Arc RPC nodes: the block timestamp of the latest block is the time source, and two price samples at least 60 s apart must be within 0.25 %, otherwise no offer is made.
4. The server returns **unsigned** calldata plus the EIP-712 `LoanTerms` the lender must sign: the lender approves USDC to the escrow (revocable FIFO commitment) and signs the exact terms (`/loan/lender-sign` verifies the signature); the borrower approves the collateral and calls `lock(terms, lenderSignature)`. `lock()` verifies the lender's signature, that the caller is the borrower named in the terms, and moves everything in one transaction: collateral into the escrow, 975 USDC lender → borrower, 25 USDC lender → house (both fixed by the contract). Nobody can spend a lender's allowance on terms the lender did not sign; a loan can never exist half-done.
5. Once the collateral lock transaction is mined, the borrower submits its hash to `/loan/confirm`; the server re-reads the `Locked` event on-chain and only then starts the 24 h IP limit.
6. No funds pass through the operator's server. No key or seed exists on it unless the optional keeper key is provisioned (§3), and that key holds no funds and no special contract permission.

## 5. Default

At loan maturity, if the borrower has not repaid, `settle()` sells the collateral on-chain through the configured DEX router: the lender receives principal + interest, the house pays any shortfall via `payDeficit()`, and the house keeps all excess. The borrower receives nothing on default. On time, `repay()` pays the lender directly and returns the collateral, atomically.

The house's loss absorption rests on its own thesis: a target default rate below 0.5 % with 25 % loan-to-value, so the 2.5 % fee on the other ~99.5 % of loans is expected to cover shortfalls. This must be confirmed with real default statistics, and a sharp fall in bitcoin would hit every loan at once since cirBTC is the sole collateral.

## 6. Abuse and memory controls

- After a validated collateral lock, further requests from that IP for 24 h are cut with `req.destroy()` / `res.destroy()`.
- IPs are stored only as HMAC-SHA-256 fingerprints under a random in-memory key.
- Request buffers are cleared when the response closes. Every 300,000 ms expired fingerprints are removed and `global.gc()` runs (`--expose-gc`; heap limit `--max-old-space-size=2048`).
- Bodies are limited to 4 KB.

## 7. Honest limits

- **Non-custodial server, non-upgradeable contract.** `LoanEscrow` has no admin key, no pause switch, no upgrade path. This is a deliberate audit-surface reduction, traded against the ability to patch a bug in place — a bug found after mainnet deployment requires a new contract and a new loan cohort, not a hotfix.
- **DEX liquidity depth for cirBTC/USDC is unverified.** `amountOutMinimum` protects against a single bad fill but not against a pool with too little depth to clear a sale at all. This must be checked against the real Arc cirBTC/USDC pool before mainnet.
- **Price source is a placeholder.** `priceProvider()` in production needs a real on-chain oracle or DEX quote call for cirBTC/USDC; this is not yet wired to a live Arc price feed (see `src/params.js` and the `TODO(user)` placeholders below).
- **`cancel()` returns collateral to the defaulting borrower**, not the house, if nobody calls `settle()` before `cancelAfter`. This is the same disclosed limitation as the XRPL build's escrow-cancel behavior, carried over on purpose rather than hidden: the permissionless design means someone (a keeper, the lender, the house) is expected to call `settle()` in the window, but nothing on-chain forces it.
- **KYC list freshness:** the list is only as current as the provider's last export. Revocations need a reload (restart) of the service.
- **House solvency:** a sharp fall in bitcoin (the only collateral) can exceed fee income.
- RAM clearing in JavaScript is best-effort.

## 8. Tests and demo

- `npm test`: pure-JS logic suite (quoting, settlement math, conservation checks, FIFO queue, KYC registry, IP guard, stress tests, server routing) under `node --test`. Live Arc Mainnet checks are opt-in and run only when `ARC_RPC_URL` is explicitly set in the test environment.
- `npm run test:contract`: Hardhat Network suite exercising `LoanEscrow.sol` directly — lock → repay, lock → default → settle with excess, lock → default → settle with deficit → `payDeficit`, lock → `cancel` (the disclosed limitation above), `settle()`'s guard rejections, and duplicate-lock rejection.
- `npm run demo` (`poc/arc-demo.js`): interactive demo against a local Hardhat node — deploys mock USDC, a mock cirBTC token, a mock DEX router, and `LoanEscrow`; walks through the FIFO queue (including an unapproved address refused from it), quote → lock, and a choice of on-time repayment, default with deficit, or default with excess, re-reading every balance and the final loan status from the chain afterward. Transactions are local Hardhat transactions, so they do not have public Arc explorer links.

## 9. Manual verification required before mainnet

The Arc Mainnet RPC endpoint, chain ID, explorer URL, and USDC ERC-20 address in
`src/params.js` are set from Circle's official documentation. The application
also checks that its RPC connection reports chain ID 5042.

These production values remain intentionally unconfigured until verified and supplied:

- cirBTC on Arc Mainnet: `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`, 8 decimals (Circle's published address, verified on-chain 2026-11-03; testnet `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF`). Set in `COLLATERAL_TOKENS.cirBTC`, overridable with env `CIRBTC_ADDRESS` / `CIRBTC_DECIMALS`; the server re-checks bytecode and decimals at startup.
- A DEX router address with real liquidity for cirBTC/USDC (`DEX_ROUTER_ADDRESS`).
- A live price source implementation for cirBTC; `bestCollateralPrice()` currently has no production source.
- The deployed `LoanEscrow` contract address (`ESCROW_CONTRACT_ADDRESS`).
- Company house address (`HOUSE_ADDRESS`) in `/etc/d-kyc/d-kyc.env`.

# Audit scope - Arc micro-loan, cirBTC/USDC (D-kyc-audit-I)

Status: proof of concept configured for Arc Mainnet metadata. **Not deployed.** Collateral is cirBTC only.

## Code to audit (production paths)

| File | Lines | Role |
|---|---:|---|
| `contracts/LoanEscrow.sol` | 221 | **The only contract that holds funds.** Immutable, no admin, no upgrade. |
| `src/server.js` | 251 | HTTP API: `/loan/request`, `/loan/confirm`, `/health`, `/terms`; KYC + IP guard + daily cap |
| `src/chain.js` | 159 | Calldata builders, `Locked` event verification, repaid-event scan, keeper wallet |
| `src/loan.js` | 79 | Quote and settlement arithmetic (LTV 25 %, fee 2.5 %, 12 %/yr over 42 days) |
| `src/settlement/settle.js` | 75 | Optional keeper sweep that calls permissionless `settle()` |
| `src/loanSession.js` | 52 | In-memory loan sessions (TTL 1 h) |
| `src/kycProviders/didit.js` | 49 | External KYC provider adapter |
| `src/guard.js` | 47 | IP fingerprint guard (HMAC-SHA-256, 24 h) |
| `src/params.js` | 47 | Network constants, cirBTC address/decimals, placeholders |
| `src/terms.js` | 34 | Terms text and version |
| `src/kyc.js` | 24 | Allowlist registry |
| `src/escrow.js` | 12 | Preimage/condition hash |
| **Production total** | **~1 050** | |
| Test mocks (`contracts/test/*.sol`) | 91 | Not deployed |
| Tests + demo (`test/`, `poc/`) | ~1 050 | `npm test` 29 pass / 4 live skipped; `npm run test:contract` 6 pass |

## Audit emphasis, in priority order

1. **`LoanEscrow.sol` - all funds flow here.**
   - `lock()`: reentrancy guard, `transferFrom` success check, no overwrite of an existing `loanId`, `finishAfter < cancelAfter`.
   - `repay()`: atomicity of lender payment + collateral return; `only borrower`, `term over` boundary (`<=` vs `<`).
   - `settle()`: permissionless; preimage check; path must start with the loan's collateral token and end in USDC; `amountOutMinimum` is caller-supplied (a keeper could pass 0: confirm this is acceptable or add a floor); excess/deficit accounting; router approval residue.
   - `payDeficit()`: house-only, deficit zeroed before transfer.
   - `cancel()`: **disclosed limitation** - after `cancelAfter`, collateral returns to the defaulting borrower, not the house.
   - 8-decimal collateral (cirBTC) vs 6-decimal USDC: unit handling in `settle()` proceeds and in tests.
   - Non-standard ERC-20 behaviour (no return value, fee-on-transfer): `_safeTransfer*` helpers; cirBTC must be checked against these assumptions.

2. **cirBTC configuration (`src/params.js`).** Mainnet `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`, testnet `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF`, 8 decimals: Circle's published addresses, verified on-chain 2026-11-03 (bytecode, `decimals()`, `symbol()`), re-verified at server startup (`verifyCollateralTokens`). Still to review: cirBTC uses the same **upgradeable proxy** architecture as USDC/EURC, with issuer pause/blocklist capabilities that could trap collateral inside the escrow or block a `settle()` transfer; assess that counterparty risk explicitly.

3. **Price and liquidity (unresolved integration).** `bestCollateralPrice()` has no production source; `DEX_ROUTER_ADDRESS` is empty. The loan is only as safe as the cirBTC/USDC price feed and pool depth at settlement. Review the two-sample stability rule (60 s, 0.25 %) for manipulation resistance once a real source is wired.

4. **Server trust boundary (`src/server.js`, `src/chain.js`).** Unsigned calldata only, no custody; `verifyCollateralLock()` binds `loanId`, borrower, lender, token and amount to the on-chain `Locked` event before the 24 h IP limit starts; secret-shaped inputs rejected; body limit 4 KB; daily cap 300.

5. **KYC (`src/kyc.js`, `src/kycProviders/didit.js`).** Address allowlist freshness, provider adapter error handling, fail-closed behaviour when the list is missing.

6. **Keeper (`src/settlement/settle.js`).** Optional; holds gas only. Confirm it cannot be tricked into settling the wrong loan or passing a harmful `amountOutMinimum`.

## Out of scope
`poc/arc-demo.js` (local Hardhat demo), `poc/arc-testnet-demo.js` and `scripts/deploy-arc-testnet.js` (Arc Testnet POC, see `deploy/ARC-TESTNET.md`), `contracts/test/` mocks, `test/`.

## Before deployment (blocking)
- cirBTC address/decimals verified on-chain; DEX router and price source implemented and reviewed.
- `LoanEscrow` constructor values (USDC `0x3600…0000`, router) verified; deployed address written to `ESCROW_CONTRACT_ADDRESS`.
- House address set in `/etc/d-kyc/d-kyc.env`; KYC file populated; see `deploy/MAINNET.md` for the Ubuntu service setup.

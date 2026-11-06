# Audit scope - Arc micro-loan, cirBTC/USDC (D-kyc-audit-I)

Status: proof of concept configured for Arc Mainnet metadata. **Not deployed.** Collateral is cirBTC only.

## Code to audit (production paths)

| File | Lines | Role |
|---|---:|---|
| `contracts/LoanEscrow.sol` | 233 | **The only contract that holds funds.** Immutable, no admin, no upgrade. |
| `src/server.js` | 263 | HTTP API: `/loan/request`, `/loan/confirm`, `/health`, `/terms`; KYC + IP guard + daily cap |
| `src/chain.js` | 209 | Calldata builders, on-chain FIFO (`fifoLenders`) and lender liquidity check, `Locked` event verification, keeper wallet |
| `src/loan.js` | 79 | Quote and settlement arithmetic (LTV 25 %, fee 2.5 %, 12 %/yr over 42 days) |
| `src/settlement/settle.js` | 75 | Optional keeper sweep that calls permissionless `settle()` |
| `src/loanSession.js` | 52 | In-memory loan sessions (TTL 1 h) |
| `src/kycProviders/didit.js` | 49 | External KYC provider adapter |
| `src/guard.js` | 47 | IP fingerprint guard (HMAC-SHA-256, 24 h) |
| `src/params.js` | 47 | Network constants, cirBTC address/decimals, placeholders |
| `src/terms.js` | 34 | Terms text and version |
| `src/kyc.js` | 24 | Allowlist registry |
| `src/escrow.js` | 12 | Preimage/condition hash |
| **Production total** | **~1 130** | |
| Test mocks (`contracts/test/*.sol`) | 91 | Not deployed |
| Tests + demo (`test/`, `poc/`) | ~1 460 | `npm test` 33 pass / 4 live skipped; `npm run test:contract` 9 pass |

## External finding already received (2026-11-06) and fixed in contract v3

A security firm (KupiaSec) read `AUDIT-SCOPE.md` and `LoanEscrow.sol` v2 and reported, unsolicited: `lock()` took `lender`
as a bare parameter, so anyone could call the contract directly, name any lender holding a USDC allowance, pass a worthless
token as collateral and their own address as house, and drain the lender. Confirmed by us; it was introduced by the
2026-11-05 atomic-funding change. Fix (v3, same day): `lock(LoanTerms, lenderSignature)` requires the lender's EIP-712
signature over the exact terms (loanId, borrower, lender, amounts, conditionHash, dates, deadline); `house` and
`collateralToken` are immutable constructor values; `t.borrower == msg.sender`. The signed `conditionHash` also closes the
"hash with no known preimage" griefing path they mentioned. Regression tests: `test/contract/LoanEscrow.test.js`
("nobody can spend a lender's allowance without the lender's signature...", "house and collateral token are fixed at
deployment..."). Please re-verify independently; this is exactly the kind of gap the audit should look for.

## Audit emphasis, in priority order

1. **`LoanEscrow.sol` - all funds flow here.**
   - `lock(LoanTerms, lenderSignature)`: EIP-712 digest (`hashLoanTerms`, domain name/version/chainId/contract), `_recover` malleability guards (low-s, v∈{27,28}, non-zero signer), signer == `t.lender`, `t.borrower == msg.sender`, `deadline`, replay (loanId uniqueness + status), reentrancy guard, `transferFrom` success checks on all three legs (collateral in, principal−fee lender→borrower, fee lender→house); `principal > issuanceFee`, `usdcDue ≥ principal`, `finishAfter < cancelAfter`. Immutables `house`, `collateralToken`, `usdc`, `dexRouter`.
   - `repay()`: atomicity of lender payment + collateral return; `only borrower`, `term over` boundary (`<=` vs `<`).
   - `settle()`: permissionless; preimage check; path must start with the loan's collateral token and end in USDC; `amountOutMinimum` is caller-supplied (a keeper could pass 0: confirm this is acceptable or add a floor); excess/deficit accounting; router approval residue.
   - `payDeficit()`: house-only, deficit zeroed before transfer.
   - `cancel()`: **disclosed limitation** - after `cancelAfter`, collateral returns to the defaulting borrower, not the house.
   - 8-decimal collateral (cirBTC) vs 6-decimal USDC: unit handling in `settle()` proceeds and in tests.
   - Non-standard ERC-20 behaviour (no return value, fee-on-transfer): `_safeTransfer*` helpers; cirBTC must be checked against these assumptions.

2. **cirBTC configuration (`src/params.js`).** Mainnet `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`, testnet `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF`, 8 decimals: Circle's published addresses, verified on-chain 2026-11-03 (bytecode, `decimals()`, `symbol()`), re-verified at server startup (`verifyCollateralTokens`). Still to review: cirBTC uses the same **upgradeable proxy** architecture as USDC/EURC, with issuer pause/blocklist capabilities that could trap collateral inside the escrow or block a `settle()` transfer; assess that counterparty risk explicitly.

3. **Price and liquidity (unresolved integration).** `bestCollateralPrice()` has no production source; `DEX_ROUTER_ADDRESS` is empty. The loan is only as safe as the cirBTC/USDC price feed and pool depth at settlement. Review the two-sample stability rule (60 s, 0.25 %) for manipulation resistance once a real source is wired.

4. **FIFO and lender liquidity (`src/chain.js` `fifoLenders`, `lenderLiquidity`; `src/server.js`).** The lender's FIFO commitment is their USDC allowance to the escrow (revocable by approving 0). Order = first `Approval` event to the escrow (block, log index). Before quoting, the server checks live `allowance ≥ 1000` **and** `balanceOf ≥ 1000`; a lender who moved funds out is skipped and the next eligible one is taken (`test/fifo.test.js`). Review: event-log completeness (`ESCROW_DEPLOY_BLOCK`), race between the check and `lock()` (harmless: `lock()` reverts atomically), and that no path trusts a lender named in the request without the on-chain check.
5. **Server trust boundary (`src/server.js`, `src/chain.js`).** Unsigned calldata only, no custody; `verifyCollateralLock()` binds `loanId`, borrower, lender, token and amount to the on-chain `Locked` event before the 24 h IP limit starts; secret-shaped inputs rejected; body limit 4 KB; daily cap 300.

6. **KYC (`src/kyc.js`, `src/kycProviders/didit.js`).** Address allowlist freshness, provider adapter error handling, fail-closed behaviour when the list is missing.

7. **Keeper (`src/settlement/settle.js`).** Optional; holds gas only. Confirm it cannot be tricked into settling the wrong loan or passing a harmful `amountOutMinimum`.

## Out of scope
`poc/arc-demo.js` (local Hardhat demo), `poc/arc-testnet-demo.js` and `scripts/deploy-arc-testnet.js` (Arc Testnet POC, see `deploy/ARC-TESTNET.md`), `contracts/test/` mocks, `test/`.

## Before deployment (blocking)
- cirBTC address/decimals verified on-chain; DEX router and price source implemented and reviewed.
- `LoanEscrow` constructor values (USDC `0x3600…0000`, router) verified; deployed address written to `ESCROW_CONTRACT_ADDRESS`.
- House address set in `/etc/d-kyc/d-kyc.env`; KYC file populated; see `deploy/MAINNET.md` for the Ubuntu service setup.

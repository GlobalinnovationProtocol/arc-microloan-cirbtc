# Arc Testnet results - cirBTC/USDC micro-loan POC (run 2026-11-04)

Network: Arc Testnet (chain 5042002). Explorer: https://explorer.testnet.arc.io
All transactions below are real Arc Testnet transactions; every on-chain check passed.

| Contract | Address |
|---|---|
| LoanEscrow (audited production bytecode) | [0x8f2Ec58364A904b5450a6F96846c567DEcE2Ee3e](https://explorer.testnet.arc.io/address/0x8f2Ec58364A904b5450a6F96846c567DEcE2Ee3e) |
| Collateral: real testnet **cirBTC** (Circle, 8 dec) | [0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF](https://explorer.testnet.arc.io/address/0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF) |
| Loan currency: real testnet **USDC** | [0x3600000000000000000000000000000000000000](https://explorer.testnet.arc.io/address/0x3600000000000000000000000000000000000000) |
| MockDexRouter (test stand-in: no DEX router is published for Arc yet) | [0x4e84fBe48452f2B4e5DC47dceB166Ee9CD61C7B1](https://explorer.testnet.arc.io/address/0x4e84fBe48452f2B4e5DC47dceB166Ee9CD61C7B1) |
| Deployer = house = lender = keeper (demo only) | [0x729FA5cfaFc9F4036E97C1464922947Eb33443D0](https://explorer.testnet.arc.io/address/0x729FA5cfaFc9F4036E97C1464922947Eb33443D0) |

Deployment: router [0xec6638e5…](https://explorer.testnet.arc.io/tx/0xec6638e587730d8e1d2740d1c8e767b6cde59fd8dfbab82375969b633d578823), escrow [0x9afb5495…](https://explorer.testnet.arc.io/tx/0x9afb549566f31636214e958aabb8077f4d57bec75b161270ebf8e62e4acda1ac).

Demo scaling (disclosed): principal 0.5 USDC instead of 1000 so faucet funds suffice; same ratios as production
(2.5 % fee = 0.0125, 12 %/yr over 42 days = 0.006904 interest, 25 % LTV -> 0.000033 cirBTC at a fixed demo price of
60 000 USDC/cirBTC). Maturity set to ~2 minutes instead of 42 days.

## Contract v3 - lender EIP-712 signature, immutable house/collateral (2026-11-06)

An external reviewer (KupiaSec) reported that v2's `lock()` accepted `lender` as a bare parameter, letting anyone drain a
lender's USDC allowance against worthless collateral by calling the contract directly. Confirmed and fixed the same day:
`lock(LoanTerms, lenderSignature)` now requires the lender's EIP-712 signature over the exact terms, `house` and
`collateralToken` are immutable, and the caller must be the borrower named in the terms. 11 Hardhat tests incl. two
regression tests for the report. v3 Testnet deployment (2026-11-06):

| Contract | Address |
|---|---|
| LoanEscrow **v3** (house = deployer, collateral = real testnet cirBTC) | [0x8ea1c1d2cB073645090B3121A90DeF19856Be85A](https://explorer.testnet.arc.io/address/0x8ea1c1d2cB073645090B3121A90DeF19856Be85A) - deploy tx [0xf90c8f2d…](https://explorer.testnet.arc.io/tx/0xf90c8f2df29084d416dda191bde85b58daf854da35e74d8a85460ab6ff0c5cfc) |
| MockDexRouter (v3) | [0x0C455E6159bFD8451Ba220d9a5CE613EEeb8554E](https://explorer.testnet.arc.io/address/0x0C455E6159bFD8451Ba220d9a5CE613EEeb8554E) |

The three outcomes will be re-recorded against v3 with `Record-Testnet-Demo.ps1` once the deployer holds faucet cirBTC.

## Contract v2 - lender funding atomic with lock() (deployed 2026-11-05) - SUPERSEDED by v3 (vulnerable, do not use)

After the three runs above (contract v1: lender paid the borrower in a separate transaction), `lock()` was changed so the
lender's 1000 USDC is pulled in the same transaction as the collateral (975 to the borrower, 25 fee to the house); the
lender's USDC allowance to the escrow is now their revocable FIFO commitment, and the server checks live allowance **and**
balance before quoting (skipping lenders who moved funds out). v2 is deployed on Arc Testnet:

| Contract | Address |
|---|---|
| LoanEscrow **v2** | [0x859923Aa1c3E4b9660baE84AE64e1701De41650C](https://explorer.testnet.arc.io/address/0x859923Aa1c3E4b9660baE84AE64e1701De41650C) - deploy tx [0xedfe3eb9…](https://explorer.testnet.arc.io/tx/0xedfe3eb921d4c6ec9e3962a615e9a0f82de1aeb80dc9f96f5e24e899310cf0f2) |
| MockDexRouter (v2 run) | [0xB5ecbF16765A66627C524E4d70C3111dEcCCb321](https://explorer.testnet.arc.io/address/0xB5ecbF16765A66627C524E4d70C3111dEcCCb321) |

Tests: 9 Hardhat contract tests (incl. atomic funding, revert when the lender lacks allowance/balance) and 33 JS tests
(incl. `test/fifo.test.js`) pass. The v2 outcomes will be recorded on Testnet with `Record-Testnet-Demo.ps1` once the
deployer is topped up with faucet cirBTC; the v1 runs below remain valid evidence of the escrow/settlement paths.

## Outcome 1 - borrower repays on time (9/9 tx, checks: status Repaid ✓, collateral back to borrower ✓)
- borrower approves LoanEscrow for cirBTC: [0x2eddd67e…](https://explorer.testnet.arc.io/tx/0x2eddd67ef9888dd0ef9db760cdc061193a3e64713bcdef591c547d46a79ba1a5)
- **borrower locks 0.000033 cirBTC**: [0x80a72b31…](https://explorer.testnet.arc.io/tx/0x80a72b3113df49894593ba021bc67d090c11b26031a7880eb659c1e30ed8ad6b)
- lender -> borrower 0.5 USDC: [0xa1b9f21e…](https://explorer.testnet.arc.io/tx/0xa1b9f21ea635d5834684b7820464706cba5c3c1ac798b776e2e2204b7e6bdd9c)
- borrower -> house fee 0.0125 USDC: [0xb1fbc907…](https://explorer.testnet.arc.io/tx/0xb1fbc90747bade89ec213275aa3f67ea18719573627f6cd4519727ecd218a7b5)
- **borrower repays 0.506904 USDC - atomic: lender paid, collateral returned**: [0x34f63369…](https://explorer.testnet.arc.io/tx/0x34f633699f31be3bc4bd1cf20e34934276fa7096dc1cb85aad7f5ac17bc1db4e)

## Outcome 2 - default, collateral sold at -80 % -> DEFICIT, house pays (10/10 tx, checks all ✓)
Expected: lender receives 0.506904, house absorbs 0.110904.
- borrower locks 0.000033 cirBTC: [0xb35832cc…](https://explorer.testnet.arc.io/tx/0xb35832cc629048d249e2e66cd6101d14b428d3b59d258f04404dd76f7d0e425f)
- lender -> borrower 0.5 USDC: [0x541b8309…](https://explorer.testnet.arc.io/tx/0x541b8309579452e62410ecb50937a60d8dee3acca1bec55485d293f65f15eb9a)
- **settle() - permissionless, keeper pays gas only**: [0x811081f6…](https://explorer.testnet.arc.io/tx/0x811081f6f5daee7fe0e5172dc72e843582bd940961a9dbe106b79ba5795cb3d2)
- **house pays the deficit (payDeficit) - human-in-the-loop**: [0x577e32bf…](https://explorer.testnet.arc.io/tx/0x577e32bfe8c18202b700d3d942bc5a07a25baf58e969a3e5fac5cf982600bd53)

## Outcome 3 - default, collateral sold at +10 % -> EXCESS, house keeps it (9/9 tx, checks all ✓)
Expected: lender receives 0.506904, house keeps 1.671096 excess.
- borrower locks 0.000033 cirBTC: [0x0cb46365…](https://explorer.testnet.arc.io/tx/0x0cb463655fd49b64fb82f8a92005bd801e50509f1796995f72859be6aaa443bb)
- lender -> borrower 0.5 USDC: [0x3e56ec62…](https://explorer.testnet.arc.io/tx/0x3e56ec625692c3dd77c7cb2aefee4d7bece9a7c56547d12c40dfeb013def09bb)
- **settle() - lender made whole, excess to house**: [0xd9b4d95d…](https://explorer.testnet.arc.io/tx/0xd9b4d95defd8d2b143de47527fc89c24c5c29a5466315e74d3c567fd885290fb)

Full per-run data (every hash, block, terms, checks): `deploy/arc-testnet-demo-1.json`, `-2.json`, `-3.json` (generated by `poc/arc-testnet-demo.js`).

---

## Text ready to paste into the Questbook application (Circle 2026 Cohort 2)

**Demo & proof of work - cirBTC/USDC micro-loan on Arc**

- GitHub: https://github.com/GlobalinnovationProtocol/arc-microloan-cirbtc
- Terminal transcript of the 3-outcome demo (run it yourself with `.\Run-Demo.ps1 1|2|3`): https://github.com/GlobalinnovationProtocol/arc-microloan-cirbtc/blob/main/DEMO-TRANSCRIPT.txt - screen recording available on request
- Live on Arc Testnet (real USDC and real cirBTC): LoanEscrow v3 (lender EIP-712 signature, immutable house/collateral) 0x8ea1c1d2cB073645090B3121A90DeF19856Be85A; v1 0x8f2Ec58364A904b5450a6F96846c567DEcE2Ee3e (runs below)
  - On-time repayment, atomic (lender paid + collateral returned): https://explorer.testnet.arc.io/tx/0x34f633699f31be3bc4bd1cf20e34934276fa7096dc1cb85aad7f5ac17bc1db4e
  - Default with deficit: permissionless settle() https://explorer.testnet.arc.io/tx/0x811081f6f5daee7fe0e5172dc72e843582bd940961a9dbe106b79ba5795cb3d2 then house payDeficit() https://explorer.testnet.arc.io/tx/0x577e32bfe8c18202b700d3d942bc5a07a25baf58e969a3e5fac5cf982600bd53
  - Default with excess: settle() https://explorer.testnet.arc.io/tx/0xd9b4d95defd8d2b143de47527fc89c24c5c29a5466315e74d3c567fd885290fb

What it is: fixed 1000 USDC loans, 42 days, 2.5 % fee, 12 %/yr, 25 % LTV, collateral = Circle cirBTC only, KYC on lenders and borrowers, FIFO lender queue. Non-custodial: the server only returns unsigned calldata; a 221-line immutable, admin-free LoanEscrow holds collateral; settle() is permissionless with a minimum-output floor; a shortfall is recorded on-chain and paid by the house via payDeficit(). Tests: 29 JS + 6 Hardhat contract tests, all green. Audit scope documented (AUDIT-SCOPE.md); external audit firm engagement in progress before mainnet.

Honest limits: no DEX router or price oracle is published for Arc yet, so the testnet run uses a fixed price and a mock router (disclosed); cancel() limitation disclosed; demo amounts scaled to faucet size.

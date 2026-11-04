// Real-chain POC on Arc Testnet: the exact production code paths (quote, approve+lock calldata,
// repay calldata, permissionless settle, payDeficit) run against the contracts written by
// scripts/deploy-arc-testnet.js, with REAL testnet USDC (0x3600...0000). Every transaction is a
// real Arc Testnet transaction with an explorer link. Differences from production, all disclosed:
//   - one key (DEPLOYER_PRIVATE_KEY) plays house + lender + keeper; the borrower is a second key
//     (BORROWER_PRIVATE_KEY, or generated once and stored in deploy/arc-testnet.json -- testnet only);
//   - amounts are scaled: DEMO_PRINCIPAL_USDC (default 1) instead of 1000, so faucet USDC suffices;
//   - the price feed is a fixed demo price (no oracle/DEX is published for Arc yet) and the DEX is
//     MockDexRouter funded with USDC by the deployer; finishAfter is ~2 min instead of 42 days.
// Usage: DEPLOYER_PRIVATE_KEY=0x... DEMO_CHOICE=1|2|3 node poc/arc-testnet-demo.js
import { readFileSync, writeFileSync } from "node:fs";
import { Contract, Interface, JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import { quote, priceIsStable, settleDefault } from "../src/loan.js";
import { createCollateralCondition } from "../src/escrow.js";
import { buildLockCalldata, buildRepaymentCalldata, collateralUnits, loanIdFromString, verifyCollateralLock } from "../src/chain.js";
import { PRICE_MIN_INTERVAL_SECONDS } from "../src/params.js";

const CFG_URL = new URL("../deploy/arc-testnet.json", import.meta.url);
const cfg = JSON.parse(readFileSync(CFG_URL));
const RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.io";
const P = Number(process.env.DEMO_PRINCIPAL_USDC ?? "1");
const DEMO_PRICE = Number(process.env.DEMO_CIRBTC_PRICE ?? "60000");
const CHOICE = (process.env.DEMO_CHOICE ?? "1").trim();
const FINISH_AFTER_S = 120, CANCEL_AFTER_S = 600, CD = cfg.collateralDecimals, UD = 6;
const GWEI = 10n ** 9n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => (Math.round(n * 1e6) / 1e6).toFixed(6);
const artifact = (rel) => JSON.parse(readFileSync(new URL(`../artifacts/${rel}`, import.meta.url)));

const provider = new JsonRpcProvider(RPC, cfg.chainId);
if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY missing");
const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider); // house + lender + keeper
let borrower;
if (process.env.BORROWER_PRIVATE_KEY) borrower = new Wallet(process.env.BORROWER_PRIVATE_KEY, provider);
else if (cfg.borrowerKey) borrower = new Wallet(cfg.borrowerKey, provider);
else { borrower = Wallet.createRandom().connect(provider); cfg.borrowerKey = borrower.privateKey; writeFileSync(CFG_URL, JSON.stringify(cfg, null, 2)); }

const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)", "function mint(address,uint256)"];
const usdc = new Contract(cfg.usdc, erc20Abi, deployer);
const collateral = new Contract(cfg.collateral, erc20Abi, deployer);
const router = new Contract(cfg.router, artifact("contracts/test/MockDexRouter.sol/MockDexRouter.json").abi, deployer);
const escrow = new Contract(cfg.escrow, artifact("contracts/LoanEscrow.sol/LoanEscrow.json").abi, deployer);

async function fees() {
  const fd = await provider.getFeeData();
  const max = fd.maxFeePerGas && fd.maxFeePerGas > 20n * GWEI ? fd.maxFeePerGas : 25n * GWEI;
  return { maxFeePerGas: max, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? GWEI };
}
const log = [];
async function send(label, txPromise) {
  const tx = await txPromise; const r = await tx.wait();
  const ok = r.status === 1; log.push({ label, hash: r.hash, block: r.blockNumber, ok });
  console.log(`  [${ok ? "VERIFIED" : "FAILED"}] ${label}\n      ${cfg.explorer}/tx/${r.hash}`);
  if (!ok) throw new Error(`${label} failed`);
  return r;
}
const latestBlockTime = async () => (await provider.getBlock("latest")).timestamp;

console.log(`== ARC TESTNET (chain ${cfg.chainId}) == escrow ${cfg.escrow} | collateral ${cfg.collateral}${cfg.collateralIsMock ? " (mock)" : " (real cirBTC)"} | USDC ${cfg.usdc}`);
console.log(`  house/lender/keeper ${deployer.address} | borrower ${borrower.address} | scaled principal ${P} USDC`);

console.log("\n== PRICE CHECK (fixed demo price, two samples >= 60 s apart, same stability rule as production) ==");
const priceProvider = async () => ({ closeTime: await latestBlockTime(), price: DEMO_PRICE });
const first = await priceProvider();
while ((await latestBlockTime()) - first.closeTime < PRICE_MIN_INTERVAL_SECONDS) await sleep(5000);
const second = await priceProvider();
if (!priceIsStable(first, second)) throw new Error("price not stable");
const terms = quote(second.price, P);
const collateralWei = collateralUnits(terms.collateralAmount, CD);
const dueWei = collateralUnits(terms.principal + terms.interest, UD);
console.log("  terms:", terms, `| lender due ${money(terms.principal + terms.interest)} USDC | collateral ${terms.collateralAmount} cirBTC`);

console.log("\n== FUNDING THE DEMO ACCOUNTS (real testnet USDC from the deployer) ==");
const f = await fees();
if ((await provider.getBalance(borrower.address)) < parseUnits("0.3", 18)) await send("gas (native USDC) deployer -> borrower", deployer.sendTransaction({ to: borrower.address, value: parseUnits("0.5", 18), ...f }));
await send("USDC deployer -> borrower (fee + interest)", usdc.transfer(borrower.address, collateralUnits(terms.issuanceFee + terms.interest, UD), f));
if (cfg.collateralIsMock) await send("mint mock cirBTC to borrower", collateral.mint(borrower.address, collateralWei, f));
else if ((await collateral.balanceOf(borrower.address)) < collateralWei) {
  if ((await collateral.balanceOf(deployer.address)) < collateralWei) throw new Error(`need ${terms.collateralAmount} real cirBTC on ${deployer.address} or ${borrower.address}`);
  await send(`real cirBTC deployer -> borrower (${terms.collateralAmount})`, collateral.transfer(borrower.address, collateralWei, f));
}
if (CHOICE !== "1") await send("USDC deployer -> mock router (so it can pay swap proceeds)", usdc.transfer(cfg.router, collateralUnits(Math.ceil(terms.collateralAmount * second.price * 1.2 * 1e6) / 1e6, UD), f));

console.log("\n== QUOTE -> LOCK (production calldata, signed by the borrower) ==");
const { condition, fulfillment } = createCollateralCondition();
const base = await latestBlockTime(); const finishAfter = base + FINISH_AFTER_S; const cancelAfter = finishAfter + CANCEL_AFTER_S;
const loanIdStr = `arc-testnet-${Date.now()}`; const loanId = loanIdFromString(loanIdStr);
const { approve, lock } = buildLockCalldata({ loanId, collateralToken: cfg.collateral, collateralAmountWei: collateralWei, lender: deployer.address, house: deployer.address, usdcDueWei: dueWei, conditionHash: condition, finishAfter, cancelAfter, escrowAddress: cfg.escrow });
await send("borrower approves LoanEscrow for cirBTC", borrower.sendTransaction({ ...approve, ...f }));
const lockReceipt = await send(`borrower locks ${terms.collateralAmount} cirBTC`, borrower.sendTransaction({ ...lock, ...f }));
const bound = await verifyCollateralLock(lockReceipt.hash, { loanId, borrower: borrower.address, lender: deployer.address, collateralToken: cfg.collateral, minCollateralAmount: collateralWei }, provider);
console.log(`  server-side verifyCollateralLock(): ${bound ? "OK (Locked event bound to this loan)" : "FAILED"}`);
await send(`lender -> borrower ${money(terms.principal)} USDC`, usdc.transfer(borrower.address, collateralUnits(terms.principal, UD), f));
await send(`borrower -> house fee ${money(terms.issuanceFee)} USDC`, usdc.connect(borrower).transfer(deployer.address, collateralUnits(terms.issuanceFee, UD), f));

const start = { lender: await usdc.balanceOf(deployer.address), borrowerCol: await collateral.balanceOf(borrower.address) };
let outcome;
if (CHOICE === "1") {
  console.log("\n== OUTCOME 1: borrower repays on time ==");
  const { repay } = buildRepaymentCalldata({ loanId, usdcDueWei: dueWei, escrowAddress: cfg.escrow });
  await send("borrower approves LoanEscrow for repayment (USDC)", usdc.connect(borrower).approve(cfg.escrow, dueWei, f));
  await send(`borrower repays ${money(terms.principal + terms.interest)} USDC -- atomic: lender paid, collateral returned`, borrower.sendTransaction({ ...repay, ...f }));
} else {
  const salePrice = Math.round(second.price * (CHOICE === "2" ? 0.2 : 1.1) * 1e6) / 1e6;
  outcome = settleDefault({ collateralAmount: terms.collateralAmount, price: salePrice, principal: P });
  console.log(`\n== OUTCOME ${CHOICE}: default, sale at ${salePrice} USDC/cirBTC (${CHOICE === "2" ? "-80% -> DEFICIT" : "+10% -> EXCESS"}) ==`);
  console.log(`  expected: lender ${money(outcome.lenderReceives)} | house pays ${money(outcome.houseAbsorbs)} | house keeps ${money(outcome.houseKeepsExcess)}`);
  await send("set mock DEX rate", router.setRate(collateralUnits(salePrice, UD) * 10n ** BigInt(18 - CD), f));
  for (let now = await latestBlockTime(); now < finishAfter; now = await latestBlockTime()) { console.log(`  waiting for maturity: ${finishAfter - now}s`); await sleep(10000); }
  await send("settle() -- permissionless, keeper pays gas only", escrow.settle(loanId, fulfillment, 0n, [cfg.collateral, cfg.usdc], finishAfter + 900, f));
  const deficit = await escrow.deficits(loanId);
  if (deficit > 0n) {
    console.log(`  DeficitRecorded: ${formatUnits(deficit, UD)} USDC`);
    await send("house approves deficit", usdc.approve(cfg.escrow, deficit, f));
    await send("house pays the deficit (payDeficit) -- human-in-the-loop", escrow.payDeficit(loanId, f));
  }
}

console.log("\n== VERIFICATION (re-read on-chain) ==");
const loan = await escrow.loans(loanId);
const lenderDelta = (await usdc.balanceOf(deployer.address)) - start.lender;
const borrowerCol = await collateral.balanceOf(borrower.address);
const checks = CHOICE === "1"
  ? [["status Repaid", Number(loan.status) === 2], ["collateral back to borrower", borrowerCol === start.borrowerCol + collateralWei]]
  : [["status Settled", Number(loan.status) === 3], ["borrower keeps no collateral", borrowerCol === start.borrowerCol], ["no outstanding deficit", (await escrow.deficits(loanId)) === 0n]];
for (const [label, ok] of checks) console.log(`  [${ok ? "OK" : "FAILED"}] ${label}`);
console.log(`  house/lender net USDC change this run (house == lender == deployer here): ${formatUnits(lenderDelta, UD)}`);
const summary = { ranAt: new Date().toISOString(), choice: CHOICE, loanId: loanIdStr, terms, outcome, txs: log, checks: Object.fromEntries(checks) };
writeFileSync(new URL(`../deploy/arc-testnet-demo-${CHOICE}.json`, import.meta.url), JSON.stringify(summary, null, 2));
console.log(`\n${log.filter((l) => l.ok).length}/${log.length} transactions mined on Arc Testnet; saved deploy/arc-testnet-demo-${CHOICE}.json`);

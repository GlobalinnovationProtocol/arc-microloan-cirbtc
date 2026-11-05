import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ContractFactory, JsonRpcProvider, formatUnits } from "ethers";
import { ACCEPT_PHRASE, TERMS_TEXT, TERMS_VERSION } from "../src/terms.js";
import { LenderQueue, priceIsStable, quote, settleDefault } from "../src/loan.js";
import { createCollateralCondition } from "../src/escrow.js";
import { KycRegistry } from "../src/kyc.js";
import {
  buildLockCalldata, buildRepaymentCalldata, collateralUnits, escrowContract, loanIdFromString,
} from "../src/chain.js";
import { PRICE_MIN_INTERVAL_SECONDS } from "../src/params.js";

// Local-only demo: this never touches Arc mainnet (which remains unverified -- see
// src/params.js). It runs against `npx hardhat node`, which must already be running in another
// terminal. Everything here -- the quote, the lock/repay calldata, the condition hash -- is the
// exact production code from src/, not a simplified stand-in; only the chain (Hardhat Network
// instead of Arc) and the two ERC-20s (MockERC20 instead of real USDC/collateral) are swapped for
// a local demo. One LoanEscrow instance accepts any of the five collateral symbols as a per-loan
// parameter -- the same contract, same audit. This deployment allows exactly one collateral:
// cirBTC, Circle's natively issued bitcoin token on Arc (an ERC-20, since Arc's gas is USDC).
// The 8 decimals and starting price below are demo-only assumptions and must be verified against
// Circle's deployed cirBTC before mainnet (src/params.js COLLATERAL_TOKENS).
const COLLATERAL_INFO = {
  cirBTC: { name: "Mock cirBTC", decimals: 8, demoPrice: 60000 },
};
const RPC_URL = "http://127.0.0.1:8545";
const EXPLORER = "(local Hardhat node -- no public explorer; Arc mainnet explorer URL is an unverified placeholder, see src/params.js ARC_EXPLORER_TX_URL)";
const DEMO_COLLATERAL_SYMBOL = process.env.DEMO_COLLATERAL_SYMBOL ?? "cirBTC";
if (!COLLATERAL_INFO[DEMO_COLLATERAL_SYMBOL]) {
  throw new Error(`DEMO_COLLATERAL_SYMBOL must be one of ${Object.keys(COLLATERAL_INFO).join(", ")}, got "${DEMO_COLLATERAL_SYMBOL}"`);
}
const { name: COLLATERAL_NAME, decimals: COLLATERAL_DECIMALS, demoPrice: COLLATERAL_DEMO_PRICE } = COLLATERAL_INFO[DEMO_COLLATERAL_SYMBOL];
const USDC_DECIMALS_DEMO = 6;
const FINISH_AFTER_S = 20;
const CANCEL_AFTER_S = 150;

const rl = createInterface({ input: stdin, output: stdout });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => (Math.round(n * 1e6) / 1e6).toFixed(6);

function artifact(relPath) {
  return JSON.parse(readFileSync(new URL(`../artifacts/${relPath}`, import.meta.url)));
}

const log = [];
async function send(label, txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  const ok = receipt.status === 1;
  console.log(`  [${ok ? "VERIFIED" : "FAILED"}] ${label}\n      block ${receipt.blockNumber}, tx ${receipt.hash}\n      ${EXPLORER}`);
  log.push({ label, hash: receipt.hash, ok });
  if (!ok) throw new Error(`${label} failed`);
  return receipt;
}

async function balance(token, account) {
  return token.balanceOf(account);
}

console.log(`\n${TERMS_TEXT}\n`);
for (const role of ["LENDER", "BORROWER"]) {
  const answer = process.env.DEMO_ACCEPT_TERMS === "1"
    ? ACCEPT_PHRASE
    : (await rl.question(`${role}: type "${ACCEPT_PHRASE}" to accept the disclaimer and terms of use and continue: `)).trim();
  if (answer !== ACCEPT_PHRASE) {
    console.log(`${role} did not accept the terms. Stopping: no loan, no transaction.`);
    process.exit(0);
  }
  console.log(`  ${role} accepted terms version ${TERMS_VERSION}`);
}

console.log("\n== CONNECTING TO LOCAL HARDHAT NODE ==");
console.log(`  (run "npx hardhat node" in another terminal first if this fails to connect)`);
const provider = new JsonRpcProvider(RPC_URL);
// ethers v6's JsonRpcProvider caches getBlock("latest") results internally, so back-to-back
// calls right after an evm_mine can return a stale block. Use the raw JSON-RPC call instead,
// which bypasses that cache and always reflects the node's current chain head.
async function latestBlockTime() {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  return parseInt(block.timestamp, 16);
}
const accountAddrs = await provider.send("eth_accounts", []);
const [deployerAddr, houseAddr, borrowerAddr, lender1Addr, lender2Addr, keeperAddr] = accountAddrs;
const deployer = await provider.getSigner(deployerAddr);
const house = await provider.getSigner(houseAddr);
const borrower = await provider.getSigner(borrowerAddr);
const lender1 = await provider.getSigner(lender1Addr);
const lender2 = await provider.getSigner(lender2Addr);
const keeper = await provider.getSigner(keeperAddr);
console.log(`  deployer  ${deployerAddr}`);
console.log(`  house     ${houseAddr}`);
console.log(`  borrower  ${borrowerAddr}`);
console.log(`  lender1   ${lender1Addr}`);
console.log(`  lender2   ${lender2Addr}`);
console.log(`  keeper    ${keeperAddr}  (pays settle() gas only -- no funds, no special permission)`);

console.log(`\n== DEPLOYING CONTRACTS (mock USDC + mock ${DEMO_COLLATERAL_SYMBOL} + mock DEX router + LoanEscrow) ==`);
const erc20Artifact = artifact("contracts/test/MockERC20.sol/MockERC20.json");
const routerArtifact = artifact("contracts/test/MockDexRouter.sol/MockDexRouter.json");
const escrowArtifact = artifact("contracts/LoanEscrow.sol/LoanEscrow.json");

const usdcFactory = new ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, deployer);
const usdc = await (await usdcFactory.deploy("Mock USDC", "mUSDC", USDC_DECIMALS_DEMO)).waitForDeployment();
const collateralFactory = new ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, deployer);
const collateral = await (await collateralFactory.deploy(COLLATERAL_NAME, `m${DEMO_COLLATERAL_SYMBOL}`, COLLATERAL_DECIMALS)).waitForDeployment();
const routerFactory = new ContractFactory(routerArtifact.abi, routerArtifact.bytecode, deployer);
const router = await (await routerFactory.deploy()).waitForDeployment();
const escrowFactory = new ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, deployer);
const escrow = await (await escrowFactory.deploy(await usdc.getAddress(), await router.getAddress())).waitForDeployment();
const escrowAddress = await escrow.getAddress();
const collateralAddress = await collateral.getAddress();
const usdcAddress = await usdc.getAddress();
console.log(`  mock USDC        ${usdcAddress}`);
console.log(`  mock ${DEMO_COLLATERAL_SYMBOL.padEnd(8)} ${collateralAddress}`);
console.log(`  mock DEX router  ${await router.getAddress()}`);
console.log(`  LoanEscrow       ${escrowAddress}  (one contract, collateral token is a per-loan parameter)`);

console.log("\n== LIVE PRICE CHECK (this demo's block-timestamp price feed, same stability rule as production) ==");
let simulatedPrice = COLLATERAL_DEMO_PRICE;
const priceProvider = async () => ({ closeTime: await latestBlockTime(), price: simulatedPrice });
const first = await priceProvider();
console.log(`  Sample 1: ${first.price.toFixed(6)} USDC/${DEMO_COLLATERAL_SYMBOL} @ block time ${first.closeTime}`);
await provider.send("evm_increaseTime", [PRICE_MIN_INTERVAL_SECONDS]);
await provider.send("evm_mine", []);
let second = await priceProvider();
console.log(`  Sample 2: ${second.price.toFixed(6)} USDC/${DEMO_COLLATERAL_SYMBOL} @ block time ${second.closeTime}`);
if (!priceIsStable(first, second)) throw new Error("PRICE NOT STABLE: no loan offered");
console.log("  PRICE STABLE: OK");

const terms = quote(second.price);
const due = money(terms.principal + terms.interest);
console.log("\nTerms:", terms, `| lender due ${due} USDC`);

console.log("\n== FUNDING (mock tokens; Hardhat Network accounts, no real funds) ==");
await send("mint borrower collateral", collateral.mint(borrowerAddr, collateralUnits(terms.collateralAmount, COLLATERAL_DECIMALS)));
await send("mint borrower USDC for fee+interest", usdc.mint(borrowerAddr, collateralUnits(terms.issuanceFee + terms.interest, USDC_DECIMALS_DEMO)));
await send("mint router USDC (so it can pay out swap proceeds on default)", usdc.mint(await router.getAddress(), collateralUnits(1_000_000, USDC_DECIMALS_DEMO)));
await send("mint house USDC (so it can cover payDeficit() if the sale falls short)", usdc.mint(houseAddr, collateralUnits(terms.principal + terms.interest, USDC_DECIMALS_DEMO)));

console.log("\n== KYC AND FIFO LENDER QUEUE ==");
const kyc = new KycRegistry([lender1Addr, lender2Addr, borrowerAddr]);
console.log(`  approved: lender1, lender2, borrower. house/keeper are not approved.`);
const queue = new LenderQueue(kyc);
try {
  queue.add(houseAddr);
} catch (error) {
  console.log(`  unapproved address refused from the queue: ${error.message}`);
}
const depositors = [];
const answers = (process.env.DEMO_LENDER_DEPOSITS ?? "").split(",").map((s) => s.trim().toLowerCase());
for (const [i, name, signer, addr] of [["lender1", lender1, lender1Addr], ["lender2", lender2, lender2Addr]].map(([n, s, a], idx) => [idx, n, s, a])) {
  const answer = answers[i] || (await rl.question(`${name}: deposit ${money(terms.principal)} USDC to lend? (y/n): `)).trim().toLowerCase();
  if (answer !== "y") {
    console.log(`  ${name} does not deposit: not in the queue`);
    continue;
  }
  await send(`mint ${name} principal`, usdc.mint(addr, collateralUnits(terms.principal, USDC_DECIMALS_DEMO)));
  queue.add(addr);
  depositors.push(name);
  console.log(`  ${name} funded ${money(terms.principal)} USDC -> FIFO rank #${depositors.length}`);
}
if (!depositors.length) throw new Error("no lender deposited: no loan can be made");
const lenderAddr = queue.next();
const lenderName = lenderAddr === lender1Addr ? "lender1" : "lender2";
console.log(`  rank #1 serves the loan: ${lenderName} (${lenderAddr}); ${queue.size} still waiting`);
const lenderSigner = lenderName === "lender1" ? lender1 : lender2;

console.log("\n== QUOTE -> LOCK (the exact unsigned payloads /loan/request returns, signed and sent here by the demo wallets) ==");
const { condition, fulfillment } = createCollateralCondition();
const collateralAmountWei = collateralUnits(terms.collateralAmount, COLLATERAL_DECIMALS);
const usdcDueWei = collateralUnits(terms.principal + terms.interest, USDC_DECIMALS_DEMO);
const base = await latestBlockTime();
const finishAfter = base + FINISH_AFTER_S;
const cancelAfter = finishAfter + CANCEL_AFTER_S;
const loanId = loanIdFromString(`demo-${Date.now()}`);

const { lenderApprove, approve: lockApprove, lock } = buildLockCalldata({
  loanId, collateralToken: collateralAddress, collateralAmountWei, lender: lenderAddr, house: houseAddr,
  principalWei: collateralUnits(terms.principal, USDC_DECIMALS_DEMO), issuanceFeeWei: collateralUnits(terms.issuanceFee, USDC_DECIMALS_DEMO),
  usdcDueWei, conditionHash: condition, finishAfter, cancelAfter, escrowAddress,
});
// buildLockCalldata targets the production USDC_ADDRESS; on this local node the lender approves the deployed mock USDC instead.
await send(`lender approves LoanEscrow for ${money(terms.principal)} USDC (revocable FIFO commitment)`, usdc.connect(lenderSigner).approve(escrowAddress, collateralUnits(terms.principal, USDC_DECIMALS_DEMO)));
await send("borrower approves LoanEscrow for collateral", borrower.sendTransaction(lockApprove));
await send(`borrower locks ${terms.collateralAmount} ${DEMO_COLLATERAL_SYMBOL} -- ATOMIC: collateral in, ${money(terms.principal - terms.issuanceFee)} USDC lender -> borrower, ${money(terms.issuanceFee)} USDC fee lender -> house`, borrower.sendTransaction(lock));
console.log("  (24 h IP limit starts here, after this validated lock, in the real HTTP server)");
void lenderApprove;

const startBalances = {};
for (const [name, addr] of [["lender", lenderAddr], ["borrower", borrowerAddr], ["house", houseAddr]]) {
  startBalances[name] = await balance(usdc, addr);
}

console.log("\nOutcome at the term:\n  1) Borrower repays in full\n  2) Default, sale in DEFICIT (house pays the difference)\n  3) Default, sale with EXCESS (house keeps it)");
const choice = (process.env.DEMO_CHOICE ?? (await rl.question("Choose 1, 2 or 3: "))).trim();

async function waitUntilBlockTime(target, what) {
  for (;;) {
    const now = await latestBlockTime();
    if (now >= target) return;
    console.log(`  ${what}: ${target - now}s of simulated time remaining`);
    await provider.send("evm_increaseTime", [Math.min(5, target - now)]);
    await provider.send("evm_mine", []);
  }
}

let lastOutcome;
if (choice === "1") {
  // buildRepaymentCalldata()'s approve step targets the production USDC_ADDRESS constant (a single
  // real token on Arc mainnet, correctly left as an unverified placeholder in src/params.js) -- on
  // this local node we approve against the deployed mock USDC directly instead.
  const { repay } = buildRepaymentCalldata({ loanId, usdcDueWei, escrowAddress });
  await send("borrower approves LoanEscrow for repayment", usdc.connect(borrower).approve(escrowAddress, usdcDueWei));
  await send(`borrower repays ${due} USDC (principal + interest) -- atomic: lender paid and collateral returned in one call`, borrower.sendTransaction(repay));
} else if (choice === "2" || choice === "3") {
  // Rounded immediately: raw floating-point multiplication (e.g. 3000 * 1.1) can produce more
  // than 6 decimal digits (3300.0000000000005), which parseUnits (via collateralUnits below)
  // correctly refuses to silently truncate for a 6-decimal token like USDC.
  const salePrice = Math.round(second.price * (choice === "2" ? 0.2 : 1.1) * 1e6) / 1e6;
  const outcome = settleDefault({ collateralAmount: terms.collateralAmount, price: salePrice });
  lastOutcome = outcome;
  console.log(`\nDefault. Modelled on-chain sale price ${salePrice.toFixed(6)} (${choice === "2" ? "-80%" : "+10%"} vs quoted) on ${terms.collateralAmount} ${DEMO_COLLATERAL_SYMBOL}`);
  console.log("  Expected settlement, line by line (USDC):");
  console.log(`    Lender receives            ${money(outcome.lenderReceives)}  (capital + interest)`);
  console.log(`    House pays the deficit     ${money(outcome.houseAbsorbs)}  (via payDeficit(), a manual house-triggered call)`);
  console.log(`    House keeps the excess     ${money(outcome.houseKeepsExcess)}`);
  console.log(`    Borrower receives          ${money(outcome.borrowerReceives)}  (collateral is lost; the loan principal is not repaid)`);

  // MockDexRouter's rate is "amountOut per 1e18 amountIn" (contracts/test/MockDexRouter.sol),
  // i.e. it always assumes an 18-decimal input. For an 8-decimal collateral (cirBTC)
  // the raw amountIn is 1e10 times smaller than that assumption, so the configured rate must be
  // scaled up by the same factor to still mean "salePrice USDC per whole collateral token".
  const rateScale = 10n ** BigInt(18 - COLLATERAL_DECIMALS);
  await send(`set mock DEX rate so the swap clears at ~${salePrice.toFixed(6)} USDC per ${DEMO_COLLATERAL_SYMBOL}`,
    router.setRate(collateralUnits(salePrice, USDC_DECIMALS_DEMO) * rateScale));

  await waitUntilBlockTime(finishAfter, "finish-after");
  const path = [collateralAddress, usdcAddress];
  const deadline = finishAfter + 900;
  const contract = escrowContract(keeper, escrowAddress);
  const settleReceipt = await send(
    "settle() -- permissionless: this demo's \"keeper\" account pays gas only, holds no funds, has no special contract permission",
    contract.settle(loanId, fulfillment, 0n, path, deadline),
  );
  const deficit = await escrow.deficits(loanId);
  if (deficit > 0n) {
    console.log(`  DeficitRecorded: ${formatUnits(deficit, USDC_DECIMALS_DEMO)} USDC owed by the house`);
    await send("house approves LoanEscrow for the deficit", usdc.connect(house).approve(escrowAddress, deficit));
    await send(`house pays the deficit (payDeficit) -- the human-in-the-loop control`, escrow.connect(house).payDeficit(loanId));
  }
} else {
  console.log("Invalid choice.");
  process.exit(1);
}

console.log("\n== FINAL BALANCES (re-read on-chain; mock USDC) ==");
for (const [name, addr] of [["lender", lenderAddr], ["borrower", borrowerAddr], ["house", houseAddr]]) {
  const end = await balance(usdc, addr);
  const delta = end - startBalances[name];
  console.log(`  ${name.padEnd(10)} ${formatUnits(end, USDC_DECIMALS_DEMO)}   (net since the lock: ${delta >= 0n ? "+" : ""}${formatUnits(delta, USDC_DECIMALS_DEMO)})`);
}

console.log("\n== LIVE VERIFICATION (re-read from the chain, same spirit as the XRPL build's ledger re-read) ==");
const verdicts = [];
const check = (label, ok, detail) => {
  verdicts.push(ok);
  console.log(`  [${ok ? "OK" : "FAILED"}] ${label}\n      ${detail}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1;
const lenderEnd = await balance(usdc, lenderAddr);
const lenderDelta = lenderEnd - startBalances.lender;
const houseDelta = (await balance(usdc, houseAddr)) - startBalances.house;
const loanState = await escrow.loans(loanId);

if (choice === "1") {
  check("Lender received capital + interest", near(lenderDelta, collateralUnits(terms.principal + terms.interest, USDC_DECIMALS_DEMO)),
    `lender change ${formatUnits(lenderDelta, USDC_DECIMALS_DEMO)} USDC (expected +${money(terms.principal + terms.interest)})`);
  check("Collateral returned to the borrower", Number(loanState.status) === 2 /* Repaid */ && (await balance(collateral, borrowerAddr)) === collateralAmountWei,
    `loan status ${loanState.status} (2=Repaid); borrower holds ${formatUnits(await balance(collateral, borrowerAddr), COLLATERAL_DECIMALS)} ${DEMO_COLLATERAL_SYMBOL}`);
} else {
  const expectedHouse = choice === "3" ? lastOutcome.houseKeepsExcess : -lastOutcome.houseAbsorbs;
  check("Lender received capital + interest", near(lenderDelta, collateralUnits(terms.principal + terms.interest, USDC_DECIMALS_DEMO)),
    `lender change ${formatUnits(lenderDelta, USDC_DECIMALS_DEMO)} USDC (expected +${money(terms.principal + terms.interest)})`);
  check(choice === "2" ? "House paid the deficit" : "House kept the excess", near(houseDelta, collateralUnits(expectedHouse, USDC_DECIMALS_DEMO)),
    `house change ${formatUnits(houseDelta, USDC_DECIMALS_DEMO)} USDC (expected ${expectedHouse >= 0 ? "+" : ""}${money(expectedHouse)})`);
  check("Collateral sold on-chain, nothing returned to the borrower", Number(loanState.status) === 3 /* Settled */ && (await balance(collateral, borrowerAddr)) === 0n,
    `loan status ${loanState.status} (3=Settled); borrower holds ${formatUnits(await balance(collateral, borrowerAddr), COLLATERAL_DECIMALS)} ${DEMO_COLLATERAL_SYMBOL}`);
}
console.log(`\n${verdicts.filter(Boolean).length}/${verdicts.length} final checks OK; ${log.filter((l) => l.ok).length}/${log.length} transactions mined and verified.`);
rl.close();

// Deploys the POC to Arc Testnet (chain 5042002):
//   - LoanEscrow(USDC = 0x3600...0000 real testnet USDC, router = MockDexRouter)
//   - MockDexRouter (no public DEX router is published for Arc yet -- see src/params.js DEX_ROUTER_ADDRESS)
//   - collateral: real testnet cirBTC (USE_REAL_CIRBTC=1, borrower must then hold some) or a
//     MockERC20 "cirBTC (testnet mock)" with 8 decimals (default, so the demo can mint collateral)
// Writes deploy/arc-testnet.json consumed by poc/arc-testnet-demo.js.
// Usage: DEPLOYER_PRIVATE_KEY=0x... npx hardhat run --network arcTestnet scripts/deploy-arc-testnet.js
import hre from "hardhat";
import { writeFileSync } from "node:fs";
import { CIRBTC_TESTNET, USDC_ADDRESS } from "../src/params.js";

const { ethers } = hre;
const EXPLORER = "https://explorer.testnet.arc.io";

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 5042002n) throw new Error(`expected Arc Testnet (5042002), got ${net.chainId}`);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY missing");
  const gas = await ethers.provider.getBalance(deployer.address);
  console.log(`deployer ${deployer.address} | gas balance ${ethers.formatUnits(gas, 18)} USDC (native) -- get more at https://faucet.circle.com`);
  if (gas < ethers.parseUnits("0.2", 18)) throw new Error("deployer needs at least 0.2 USDC of gas");

  const txs = {};
  const useReal = process.env.USE_REAL_CIRBTC === "1";
  let collateral = CIRBTC_TESTNET;
  if (!useReal) {
    const mock = await (await ethers.getContractFactory("MockERC20")).deploy("cirBTC (testnet mock)", "mcirBTC", 8);
    await mock.waitForDeployment(); collateral = await mock.getAddress(); txs.collateralMock = mock.deploymentTransaction().hash;
  }
  const router = await (await ethers.getContractFactory("MockDexRouter")).deploy();
  await router.waitForDeployment(); txs.router = router.deploymentTransaction().hash;
  const escrow = await (await ethers.getContractFactory("LoanEscrow")).deploy(USDC_ADDRESS, await router.getAddress());
  await escrow.waitForDeployment(); txs.escrow = escrow.deploymentTransaction().hash;

  const out = {
    network: "arcTestnet", chainId: 5042002, explorer: EXPLORER, deployedAt: new Date().toISOString(),
    deployer: deployer.address, usdc: USDC_ADDRESS, collateral, collateralIsMock: !useReal, collateralDecimals: 8,
    router: await router.getAddress(), escrow: await escrow.getAddress(), txs,
  };
  writeFileSync(new URL("../deploy/arc-testnet.json", import.meta.url), JSON.stringify(out, null, 2));
  for (const [k, v] of Object.entries(out)) if (typeof v === "string" && v.startsWith("0x") && v.length === 42) console.log(`  ${k.padEnd(10)} ${v}  ${EXPLORER}/address/${v}`);
  for (const [k, h] of Object.entries(txs)) console.log(`  tx ${k.padEnd(14)} ${EXPLORER}/tx/${h}`);
  console.log("written deploy/arc-testnet.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

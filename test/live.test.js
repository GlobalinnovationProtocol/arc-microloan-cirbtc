import test from "node:test";
import assert from "node:assert/strict";
import { USDC_ADDRESS, COLLATERAL_TOKENS } from "../src/params.js";
import { getProvider, latestBlockTime, bestCollateralPrice } from "../src/chain.js";

// Live network checks are opt-in. Set ARC_RPC_URL explicitly to run against Arc Mainnet.
const LIVE_RPC_URL = process.env.ARC_RPC_URL;
const REASON = !LIVE_RPC_URL
  ? "set ARC_RPC_URL explicitly to opt in to live Arc Mainnet checks"
  : false;

test("live: latest block time is recent", { skip: REASON }, async () => {
  const provider = getProvider(LIVE_RPC_URL);
  const timestamp = await latestBlockTime(provider);
  const ageSeconds = Date.now() / 1000 - timestamp;
  assert.ok(ageSeconds >= 0 && ageSeconds < 300, "latest block should be from the last few minutes");
});

test("live: USDC contract address is configured", { skip: REASON }, () => {
  assert.match(USDC_ADDRESS, /^0x[0-9a-fA-F]{40}$/);
});

test("live: at least one collateral token price is positive", {
  skip: REASON || (!Object.values(COLLATERAL_TOKENS).some((t) => t.address) && "no collateral token address configured yet"),
}, async () => {
  const [symbol, token] = Object.entries(COLLATERAL_TOKENS).find(([, t]) => t.address);
  const price = await bestCollateralPrice(symbol, token.priceFeed);
  assert.ok(price > 0);
});

test("live: an all-zero transaction hash does not resolve to a receipt", { skip: REASON }, async () => {
  const provider = getProvider(LIVE_RPC_URL);
  const receipt = await provider.getTransactionReceipt("0x" + "0".repeat(64));
  assert.equal(receipt, null);
});

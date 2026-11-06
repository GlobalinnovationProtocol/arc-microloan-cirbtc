import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { COLLATERAL_TOKENS } from "../src/params.js";
import { KycRegistry } from "../src/kyc.js";
import { createLoanServer } from "../src/server.js";
import { TERMS_VERSION } from "../src/terms.js";

const HOUSE = "0x" + "33".repeat(20);
const BORROWER = "0x" + "22".repeat(20);
const LENDER_A = "0x" + "a1".repeat(20); // first to approve, but moved funds out
const LENDER_B = "0x" + "b2".repeat(20); // second to approve, fully funded
const LENDER_C = "0x" + "c3".repeat(20); // funded but not KYC-approved
const ESCROW = "0x" + "77".repeat(20);
const ACCEPTED = { version: TERMS_VERSION, lender: true, borrower: true };
const PRINCIPAL = 1000n * 10n ** 6n;

function post(port, body) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/loan/request", method: "POST", agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
    });
    req.end(JSON.stringify({ acceptedTerms: ACCEPTED, ...body }));
  });
}

async function withServer(overrides, fn) {
  let t = 0;
  const server = createLoanServer({
    house: HOUSE,
    kyc: new KycRegistry([LENDER_A, LENDER_B, BORROWER]),
    priceProviders: { cirBTC: async () => ({ closeTime: (t += 60), price: 60000 }) },
    sleep: async () => {},
    escrowAddress: ESCROW,
    ...overrides,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// On-chain picture: A approved 2000 but only 500 USDC left on the account; B approved and holds 1000; C holds 1000 but is not KYC-approved.
const liquidity = {
  [LENDER_A]: { allowance: 2000n * 10n ** 6n, balance: 500n * 10n ** 6n },
  [LENDER_B]: { allowance: PRINCIPAL, balance: PRINCIPAL },
  [LENDER_C]: { allowance: PRINCIPAL, balance: PRINCIPAL },
};
const lenderLiquidity = async (lender, principalWei) => {
  const l = liquidity[lender] ?? { allowance: 0n, balance: 0n };
  return { ...l, ok: l.allowance >= principalWei && l.balance >= principalWei };
};

test("FIFO: a lender who approved first but moved funds out is skipped; the next funded, KYC-approved lender is picked", async () => {
  assert.ok(COLLATERAL_TOKENS.cirBTC.address, "cirBTC must be configured for this test");
  await withServer({ lenderLiquidity, fifoLenders: async () => [LENDER_A, LENDER_C, LENDER_B] }, async (port) => {
    const r = await post(port, { borrower: BORROWER });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.lender, LENDER_B);
    assert.ok(r.json.unsigned.lenderApprove && r.json.unsigned.approve, "returns lender USDC approval and borrower collateral approval calldata");
    assert.equal(r.json.unsigned.lock, undefined, "lock calldata only exists after the lender signs the terms (/loan/lender-sign)");
    assert.equal(r.json.lenderTypedData.message.lender, LENDER_B, "the EIP-712 terms the lender must sign name the selected lender");
    assert.equal(r.json.unsigned.lenderToBorrower, undefined, "no separate lender transfer: funding is inside lock()");
  });
});

test("FIFO: a named lender without allowance or balance is refused with 409", async () => {
  await withServer({ lenderLiquidity }, async (port) => {
    const r = await post(port, { lender: LENDER_A, borrower: BORROWER });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /approved, or does not hold/);
  });
});

test("FIFO: no eligible lender at all -> 409, nothing is quoted", async () => {
  await withServer({ lenderLiquidity, fifoLenders: async () => [LENDER_A, LENDER_C] }, async (port) => {
    const r = await post(port, { borrower: BORROWER });
    assert.equal(r.status, 409);
  });
});

test("FIFO: without an on-chain liquidity source the server refuses to quote (503), never trusts the request", async () => {
  await withServer({}, async (port) => {
    const r = await post(port, { lender: LENDER_B, borrower: BORROWER });
    assert.equal(r.status, 503);
  });
});

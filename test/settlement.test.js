import test from "node:test";
import assert from "node:assert/strict";
import { createCollateralCondition } from "../src/escrow.js";
import { LoanSessionStore } from "../src/loanSession.js";
import { runSettlement } from "../src/settlement/settle.js";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const LENDER = "0x" + "11".repeat(20);
const BORROWER = "0x" + "22".repeat(20);
const HOUSE = "0x" + "33".repeat(20);
const TOKEN = "0x" + "55".repeat(20);

test("createCollateralCondition: condition is keccak256 of a fresh 32-byte fulfillment, never reused", () => {
  const a = createCollateralCondition();
  const b = createCollateralCondition();
  assert.match(a.condition, HEX32);
  assert.match(a.fulfillment, HEX32);
  assert.notEqual(a.condition, b.condition);
  assert.notEqual(a.fulfillment, b.fulfillment);
});

function makeSession(overrides = {}) {
  const store = new LoanSessionStore();
  const { condition, fulfillment } = createCollateralCondition();
  const loanId = store.create({
    lender: LENDER, borrower: BORROWER, house: HOUSE,
    collateralSymbol: "cirBTC", collateralToken: TOKEN,
    collateralAmountWei: 2000n * 10n ** 18n, usdcDueWei: 1013808219n * 10n ** 9n,
    condition, fulfillment, finishAfter: 1000, cancelAfter: 1000 + 3 * 24 * 60 * 60,
    ...overrides,
  });
  return { store, loanId };
}

test("LoanSessionStore: create/get/markLocked/due lifecycle", () => {
  const { store, loanId } = makeSession();
  const session = store.get(loanId);
  assert.equal(session.status, "pending_collateral");
  assert.equal(store.due(2000).length, 0, "not locked yet, must not be offered for settlement");

  store.markLocked(loanId);
  assert.equal(store.get(loanId).status, "collateral_locked");
  assert.equal(store.due(999).length, 0, "before finishAfter");
  assert.equal(store.due(1000).length, 1, "at finishAfter");
  assert.equal(store.due(1000)[0].loanId, loanId);
});

test("LoanSessionStore: sweep drops stale unconfirmed sessions, keeps locked ones", () => {
  const { store, loanId } = makeSession();
  const createdAt = store.get(loanId).createdAt;
  store.sweep(1000, createdAt + 5000);
  assert.equal(store.get(loanId), undefined, "pending_collateral session older than maxAgeMs is dropped");

  const { store: store2, loanId: id2 } = makeSession();
  store2.markLocked(id2);
  const createdAt2 = store2.get(id2).createdAt;
  store2.sweep(1000, createdAt2 + 5000);
  assert.notEqual(store2.get(id2), undefined, "locked sessions are never swept");
});

test("runSettlement: on-time repayment is detected on-chain and no settle() call is attempted", async () => {
  const { store, loanId } = makeSession();
  store.markLocked(loanId);
  const session = store.get(loanId);

  const provider = {
    getBlockNumber: async () => 100,
    getLogs: async () => [{}], // any log present == a Repaid event was found for this loanId
  };

  const result = await runSettlement(session, { provider, priceProviders: {} });
  assert.equal(result.outcome, "repaid_on_time");
  assert.equal(session.status, "repaid_on_time");
});

// The settle()/payDeficit() default-path math (house absorbs a shortfall, house keeps excess,
// reentrancy/double-settle guards) is exercised on a real in-memory EVM via Hardhat, not here --
// see test/contract/LoanEscrow.test.js. Those branches require ESCROW_CONTRACT_ADDRESS to be a
// real deployed contract, which this placeholder-configured project deliberately does not have
// (src/params.js) until the user supplies real Arc-mainnet values.

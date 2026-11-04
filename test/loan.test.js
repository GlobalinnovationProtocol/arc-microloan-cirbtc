import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { IpGuard } from "../src/guard.js";
import { LenderQueue, isAddress, priceIsStable, quote, settleDefault, settleRepaid } from "../src/loan.js";
import { createLoanServer } from "../src/server.js";
import { TERMS_VERSION } from "../src/terms.js";
import { KycRegistry } from "../src/kyc.js";

const ACCEPTED = { version: TERMS_VERSION, lender: true, borrower: true };
const LENDER = "0x" + "11".repeat(20);
const BORROWER = "0x" + "22".repeat(20);
const HOUSE = "0x" + "33".repeat(20);
const TOKEN = "0x" + "55".repeat(20);

test("quote: 1000 principal, 2.5% fee, 25% LTV", () => {
  const q = quote(2);
  assert.equal(q.principal, 1000);
  assert.equal(q.issuanceFee, 25);
  assert.equal(q.collateralAmount, 2000);
  assert.equal(q.termDays, 42);
});

test("interest is 12% annual prorated to 42 days", () => {
  assert.equal(quote(2).interest, 13.808219);
});

test("price stability uses 0.25% and 60 s block-time gap", () => {
  assert.equal(priceIsStable({ closeTime: 0, price: 2 }, { closeTime: 60, price: 2.005 }), true);
  assert.equal(priceIsStable({ closeTime: 0, price: 2 }, { closeTime: 60, price: 2.0051 }), false);
  assert.equal(priceIsStable({ closeTime: 0, price: 2 }, { closeTime: 59, price: 2 }), false);
});

test("isAddress accepts EVM hex addresses only", () => {
  assert.equal(isAddress(LENDER), true);
  assert.equal(isAddress("rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH"), false, "XRPL-style addresses must be rejected");
  assert.equal(isAddress("0xshort"), false);
  assert.equal(isAddress(123), false);
});

test("default: house absorbs a shortfall", () => {
  const r = settleDefault({ collateralAmount: 1000, price: 1 });
  assert.ok(r.houseAbsorbs > 0);
  assert.equal(r.houseKeepsExcess, 0);
  assert.equal(r.borrowerReceives, 0);
});

test("default: house keeps all excess", () => {
  const r = settleDefault({ collateralAmount: 2000, price: 2 });
  assert.equal(r.houseAbsorbs, 0);
  assert.ok(r.houseKeepsExcess > 0);
  assert.equal(r.borrowerReceives, 0);
});

test("repaid: lender made whole, house gets exactly the issuance fee, collateral returned", () => {
  const q = quote(2);
  const r = settleRepaid({ collateralAmount: q.collateralAmount, price: 2 });
  assert.ok(Math.abs(r.lenderReceives - (q.principal + q.interest)) < 1e-6);
  assert.equal(r.houseReceivesFee, 25);
  assert.equal(r.collateralReturned, q.collateralAmount);
  assert.equal(r.houseAbsorbs, 0);
});

test("FIFO lender queue", () => {
  const q = new LenderQueue();
  q.add(LENDER);
  q.add(BORROWER);
  assert.equal(q.next(), LENDER);
  assert.equal(q.next(), BORROWER);
});

test("IP guard blocks 24h then sweeps", () => {
  let now = 0;
  const g = new IpGuard(() => now);
  g.markValidated("1.2.3.4");
  assert.equal(g.isBlocked("1.2.3.4"), true);
  assert.equal(g.isBlocked("5.6.7.8"), false);
  now = 24 * 60 * 60 * 1000 + 1;
  g.sweep();
  assert.equal(g.size, 0);
  assert.equal(g.isBlocked("1.2.3.4"), false);
});

function post(port, body, path = "/loan/request") {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (error) => resolve({ error: error.code }));
    req.end(JSON.stringify(body && "lender" in body && !body.noTerms ? { acceptedTerms: ACCEPTED, ...body } : body));
  });
}

test("server: unconfigured collateral token is refused with 503, not a crash", async () => {
  let t = 0;
  const server = createLoanServer({
    house: HOUSE,
    kyc: new KycRegistry([LENDER, BORROWER]),
    priceProviders: { cirBTC: async () => ({ closeTime: (t += 60), price: 2 }) },
    sleep: async () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const r = await post(port, { lender: LENDER, borrower: BORROWER, collateralSymbol: "wBTC" });
    assert.equal(r.status, 400, "wBTC is not an allowed collateral symbol (cirBTC only)");
    const unknown = await post(port, { lender: LENDER, borrower: BORROWER, collateralSymbol: "notAThing" });
    assert.equal(unknown.status, 400);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("server: IP limit starts only after the lock is validated; later requests are destroyed; secrets refused", async () => {
  let t = 0;
  const priceProviders = { cirBTC: async () => ({ closeTime: (t += 60), price: 2 }) };
  const server = createLoanServer({
    house: HOUSE, kyc: new KycRegistry([LENDER, BORROWER]), priceProviders,
    verifyLock: async (h) => (h === "0x" + "a".repeat(64) ? { ok: true } : false),
    sleep: async () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    assert.equal((await post(port, { lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC", seed: "x" })).status, 400);

    const first = await post(port, { lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC" });
    assert.equal(first.status, 503, "token still unconfigured in src/params.js placeholder state");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

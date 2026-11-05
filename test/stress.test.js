import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { COLLATERAL_TOKENS, DAILY_LOAN_CAP } from "../src/params.js";
import { KycRegistry } from "../src/kyc.js";
import { IpGuard } from "../src/guard.js";
import { quote, settleDefault, settleRepaid } from "../src/loan.js";
import { createLoanServer } from "../src/server.js";
import { TERMS_VERSION } from "../src/terms.js";

const LENDER = "0x" + "11".repeat(20);
const BORROWER = "0x" + "22".repeat(20);
const HOUSE = "0x" + "33".repeat(20);
const TOKEN = "0x" + "55".repeat(20);
const ACCEPTED = { version: TERMS_VERSION, lender: true, borrower: true };

// COLLATERAL_TOKENS is a live, shared object (src/params.js); server.js reads it on every
// request, so mutating cirBTC's entry here is enough to exercise the full 200-path HTTP tests
// without needing a real Arc-mainnet token address.
async function withConfiguredToken(fn) {
  const saved = { ...COLLATERAL_TOKENS.cirBTC };
  COLLATERAL_TOKENS.cirBTC.address = TOKEN;
  COLLATERAL_TOKENS.cirBTC.decimals = 8;
  try {
    return await fn();
  } finally {
    Object.assign(COLLATERAL_TOKENS.cirBTC, saved);
  }
}

const ESCROW = "0x" + "77".repeat(20);

function startServer(overrides = {}) {
  let t = 0;
  const server = createLoanServer({
    house: HOUSE,
    kyc: new KycRegistry([LENDER, BORROWER]),
    priceProviders: { cirBTC: async () => ({ closeTime: (t += 60), price: 2 }) },
    verifyLock: async (hash) => hash === "0x" + "a".repeat(64),
    lenderLiquidity: async () => ({ ok: true }),
    sleep: async () => {},
    escrowAddress: ESCROW,
    ...overrides,
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function post(port, body, path = "/loan/request", method = "POST") {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (error) => resolve({ error: error.code ?? "error" }));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("stress: settlement math holds across 300 loans under rising, falling and flat prices", () => {
  const patterns = {
    rising: (i) => 1 + i * 0.05,
    falling: (i) => 100 - i * 0.3,
    flat: () => 2,
  };
  for (const [name, priceAt] of Object.entries(patterns)) {
    for (let i = 0; i < DAILY_LOAN_CAP; i++) {
      const quotedPrice = Math.max(0.01, priceAt(i));
      const q = quote(quotedPrice);
      const due = Math.round((q.principal + q.interest) * 1e6) / 1e6;
      for (const maturityPrice of [quotedPrice * 0.5, quotedPrice, quotedPrice * 2]) {
        const repaid = settleRepaid({ collateralAmount: q.collateralAmount, price: quotedPrice });
        assert.equal(repaid.collateralReturned, q.collateralAmount, `${name}#${i} repaid`);
        assert.equal(repaid.houseAbsorbs, 0, `${name}#${i} repaid never costs the house`);

        const def = settleDefault({ collateralAmount: q.collateralAmount, price: maturityPrice });
        assert.equal(def.lenderReceives, due, `${name}#${i} lender made whole`);
        assert.equal(def.houseAbsorbs * def.houseKeepsExcess, 0, `${name}#${i} mutually exclusive`);
        assert.equal(def.borrowerReceives, 0, `${name}#${i} borrower gets nothing on default`);
      }
    }
  }
});

test("IpGuard: 300 validations hit the daily cap; it resets after 24h", () => {
  let now = 0;
  const g = new IpGuard(() => now);
  for (let i = 0; i < DAILY_LOAN_CAP; i++) {
    assert.equal(g.dailyCapReached(), false, `loan #${i} should still fit under the cap`);
    g.markValidated(`10.0.${Math.floor(i / 255)}.${i % 255}`);
    now += 1000;
  }
  assert.equal(g.dailyCapReached(), true, "301st loan must be refused");
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(g.dailyCapReached(), false, "cap resets once the oldest loans roll out of the 24h window");
});

test("server: daily cap reached returns 503 on /loan/request without touching KYC/price logic", async () => {
  const guard = { isBlocked: () => false, dailyCapReached: () => true, markValidated() {}, sweep() {} };
  const server = await startServer({ guard });
  const { port } = server.address();
  try {
    const r = await post(port, { acceptedTerms: ACCEPTED, lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC" });
    assert.equal(r.status, 503);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("server: malformed and abusive requests are refused with precise status codes", async () => {
  const server = await startServer();
  const { port } = server.address();
  try {
    assert.equal((await post(port, undefined)).status, 400, "no body at all");
    assert.equal((await post(port, "not an object")).status, 400, "body parses but is not an object");
    assert.equal((await post(port, [1, 2, 3])).status, 400, "body is an array");
    assert.equal((await post(port, { acceptedTerms: ACCEPTED, lender: LENDER })).status, 400, "missing borrower");
    assert.equal((await post(port, { acceptedTerms: ACCEPTED, lender: LENDER, borrower: LENDER, collateralSymbol: "cirBTC" })).status, 400, "self-lending");
    assert.equal((await post(port, { acceptedTerms: ACCEPTED, lender: 12345, borrower: BORROWER, collateralSymbol: "cirBTC" })).status, 400, "non-string lender");
    assert.equal((await post(port, { acceptedTerms: ACCEPTED, lender: "not-an-address", borrower: BORROWER, collateralSymbol: "cirBTC" })).status, 400, "invalid address");
    assert.equal((await post(port, { acceptedTerms: ACCEPTED, lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC", mnemonic: "x" })).status, 400, "secret-like field refused outright");
    assert.equal((await post(port, { lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC" })).status, 403, "terms not accepted");

    assert.equal((await post(port, { loanId: "nope", txHash: "0x00" }, "/loan/confirm")).status, 409, "confirm on an unknown loanId");
    assert.equal((await post(port, {}, "/nope")).status, 404, "unknown route");
    assert.equal((await post(port, {}, "/loan/request", "GET")).status, 404, "wrong method on a POST-only route");
    assert.equal((await post(port, {}, "/health", "POST")).status, 404, "wrong method on a GET-only route");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("server: oversized body is destroyed; health check still reports ok", async () => {
  const server = await startServer();
  const { port } = server.address();
  try {
    const result = await new Promise((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/loan/request", method: "POST", agent: false }, (res) => {
        resolve({ status: res.statusCode });
      });
      req.on("error", () => resolve({ error: true }));
      req.write(Buffer.alloc(1_000_000, "a"));
      req.end();
    });
    assert.ok(result.error || result.status === undefined, "oversized body must never produce a reply");

    const health = await post(port, undefined, "/health", "GET");
    assert.equal(health.status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("server: once an IP is validated via a real lock confirmation, further requests from it are destroyed", async () => {
  await withConfiguredToken(async () => {
    const server = await startServer();
    const { port } = server.address();
    try {
      const quoted = await post(port, { acceptedTerms: ACCEPTED, lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC" });
      assert.equal(quoted.status, 200);
      const { loanId } = JSON.parse(quoted.data);

      const confirmed = await post(port, { loanId, txHash: "0x" + "a".repeat(64) }, "/loan/confirm");
      assert.equal(confirmed.status, 200);

      const after = await post(port, { acceptedTerms: ACCEPTED, lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC" });
      assert.ok(after.error, "this IP is now blocked for the IP_WINDOW_MS cooldown; the socket is destroyed, not replied to");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

test("stress: 400 concurrent requests across 4 waves do not crash the server or leak unbounded memory", async () => {
  await withConfiguredToken(async () => {
    const server = await startServer();
    const { port } = server.address();
    try {
      const before = process.memoryUsage().heapUsed;
      let successes = 0;
      for (let wave = 0; wave < 4; wave++) {
        const results = await Promise.all(
          Array.from({ length: 100 }, () =>
            post(port, { acceptedTerms: ACCEPTED, lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC" })),
        );
        for (const r of results) {
          assert.equal(r.status, 200, `wave ${wave}: unexpected status`);
          successes++;
        }
      }
      assert.equal(successes, 400);
      if (typeof globalThis.gc === "function") globalThis.gc();
      const after = process.memoryUsage().heapUsed;
      assert.ok(after - before < 100 * 1024 * 1024, "heap growth must stay bounded across 400 requests");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

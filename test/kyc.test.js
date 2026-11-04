import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { KycRegistry } from "../src/kyc.js";
import { LenderQueue } from "../src/loan.js";
import { createLoanServer } from "../src/server.js";
import { TERMS_VERSION } from "../src/terms.js";

const LENDER = "0x" + "11".repeat(20);
const BORROWER = "0x" + "22".repeat(20);
const HOUSE = "0x" + "33".repeat(20);
const STRANGER = "0x" + "99".repeat(20);
const ACCEPTED = { version: TERMS_VERSION, lender: true, borrower: true };

test("KycRegistry: keeps only well-formed addresses", () => {
  const kyc = new KycRegistry([LENDER, "rNotAnEvmAddress", BORROWER, 12345]);
  assert.equal(kyc.size, 2);
  assert.equal(kyc.isApproved(LENDER), true);
  assert.equal(kyc.isApproved(STRANGER), false);
});

test("LenderQueue: KYC-gated queue refuses non-approved lenders, FIFO-orders approved ones", () => {
  const kyc = new KycRegistry([LENDER, BORROWER]);
  const q = new LenderQueue(kyc);
  assert.throws(() => q.add(STRANGER), /KYC/);
  q.add(LENDER);
  q.add(BORROWER);
  assert.equal(q.size, 2);
  assert.equal(q.next(), LENDER);
  assert.equal(q.next(), BORROWER);
});

test("server requires a KYC registry to start", () => {
  assert.throws(() => createLoanServer({ house: HOUSE }), /KYC/);
});

function post(port, body, path = "/loan/request") {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (error) => resolve({ error: error.code }));
    req.end(JSON.stringify(body));
  });
}

test("server: non-approved lender or borrower is refused with 403; an approved pair proceeds past KYC", async () => {
  let t = 0;
  const kyc = new KycRegistry([LENDER, BORROWER]);
  const server = createLoanServer({
    house: HOUSE, kyc,
    priceProviders: { cirBTC: async () => ({ closeTime: (t += 60), price: 2 }) },
    sleep: async () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const nonApproved = await post(port, { acceptedTerms: ACCEPTED, lender: STRANGER, borrower: BORROWER, collateralSymbol: "cirBTC" });
    assert.equal(nonApproved.status, 403);

    const approved = await post(port, { acceptedTerms: ACCEPTED, lender: LENDER, borrower: BORROWER, collateralSymbol: "cirBTC" });
    assert.equal(approved.status, 503, "KYC passed; refused later only because cirBTC has no configured token address in this test");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

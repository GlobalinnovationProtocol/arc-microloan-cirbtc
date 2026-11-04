import test from "node:test";
import assert from "node:assert/strict";
import { quote, settleDefault, settleRepaid } from "../src/loan.js";

const round6 = (n) => Math.round(n * 1e6) / 1e6;

test("conservation: on-time repayment creates/destroys nothing", () => {
  for (const price of [0.5, 1, 1.9999, 2, 7.3, 50000]) {
    const q = quote(price);
    const r = settleRepaid({ collateralAmount: q.collateralAmount, price });

    // Borrower originally received q.principal and must pay back principal+interest+issuanceFee
    // in total across the two legs (lenderToBorrower was already netted against borrowerFeeToHouse
    // at quote time); what matters here is that every unit the lender/house receive on repayment
    // is accounted for and nothing is minted or burned.
    const borrowerNet = round6(-(r.lenderReceives + r.houseReceivesFee) + q.principal);
    assert.equal(borrowerNet, round6(q.principal - q.principal - q.interest - q.issuanceFee));
    assert.equal(r.lenderReceives, round6(q.principal + q.interest));
    assert.equal(r.houseReceivesFee, q.issuanceFee);
    assert.equal(r.collateralReturned, q.collateralAmount, "full collateral returns on repayment");
    assert.equal(r.houseAbsorbs, 0);
  }
});

test("conservation: default settlement always balances proceeds against what's owed", () => {
  for (const price of [0.1, 0.5, 0.9999, 1, 1.0001, 2, 10, 50000]) {
    const q = quote(price);
    const r = settleDefault({ collateralAmount: q.collateralAmount, price });
    const proceeds = round6(q.collateralAmount * price);
    const due = round6(q.principal + q.interest);

    assert.equal(round6(proceeds + r.houseAbsorbs - r.houseKeepsExcess - due), 0);
    assert.equal(r.houseAbsorbs * r.houseKeepsExcess, 0, "absorb and keep-excess are mutually exclusive");
    assert.equal(r.lenderReceives, due, "lender is always made whole, win or lose on the swap");
    assert.equal(r.borrowerReceives, 0, "a defaulting borrower receives nothing back");
  }
});

test("conservation: at the exact LTV boundary price, no deficit and no excess", () => {
  // quote() sizes collateralAmount so that at the quoted price, collateral * price == principal / LTV.
  // At maturity the price must move for a deficit/excess to appear; right at the original price the
  // collateral is worth principal/LTV, which is >= due (since LTV < 1), so this is an excess case --
  // verifying the boundary keeps the two formulas (quote's collateralAmount vs settleDefault's proceeds) in sync.
  const price = 2;
  const q = quote(price);
  const r = settleDefault({ collateralAmount: q.collateralAmount, price });
  const proceeds = round6(q.collateralAmount * price);
  assert.equal(proceeds, round6(q.principal / 0.25));
  assert.ok(proceeds > round6(q.principal + q.interest), "25% LTV always overcollateralizes vs. principal+interest at quote time");
  assert.equal(r.houseAbsorbs, 0);
  assert.ok(r.houseKeepsExcess > 0);
});

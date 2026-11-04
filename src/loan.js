import {
  PRINCIPAL_USDC, ISSUANCE_FEE_RATE, LTV, TERM_DAYS, ANNUAL_INTEREST_RATE,
  PRICE_MAX_DEVIATION, PRICE_MIN_INTERVAL_SECONDS,
} from "./params.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function isAddress(value) {
  return typeof value === "string" && ADDRESS.test(value);
}

// price = collateral token price in USDC. collateralAmount is in the token's natural (human)
// units, same role xrpPrice/collateralXrp played in the XRPL build -- decimals-aware wei/unit
// conversion happens in src/chain.js, same split xrpToDrops had there.
export function quote(price, principal = PRINCIPAL_USDC) {
  if (!Number.isFinite(price) || price <= 0) throw new Error("invalid price");
  return {
    principal,
    issuanceFee: round6(principal * ISSUANCE_FEE_RATE),
    interest: round6(principal * ANNUAL_INTEREST_RATE * (TERM_DAYS / 365)),
    termDays: TERM_DAYS,
    collateralAmount: round6(principal / (LTV * price)),
  };
}

// Two price samples (block timestamps, seconds) must be >= 60 s apart and within 0.25%.
export function priceIsStable(first, second) {
  const interval = second.closeTime - first.closeTime;
  if (interval < PRICE_MIN_INTERVAL_SECONDS) return false;
  if (!(first.price > 0) || !(second.price > 0)) return false;
  return Math.abs(second.price - first.price) / first.price <= PRICE_MAX_DEVIATION;
}

// On-time repayment: borrower pays the lender directly; fee already went to the house; collateral returns.
export function settleRepaid({ collateralAmount, price, principal = PRINCIPAL_USDC }) {
  const q = quote(price, principal);
  return {
    lenderReceives: round6(q.principal + q.interest),
    houseReceivesFee: q.issuanceFee,
    collateralReturned: collateralAmount,
    houseAbsorbs: 0,
  };
}

// Single term, no extension. Lender is always made whole from the on-chain swap proceeds;
// house absorbs any loss (via LoanEscrow.payDeficit, a manual house-triggered call) and keeps
// any excess.
export function settleDefault({ collateralAmount, price, principal = PRINCIPAL_USDC }) {
  const { interest } = quote(price, principal);
  const due = round6(principal + interest);
  const proceeds = round6(collateralAmount * price);
  return {
    lenderReceives: due,
    houseAbsorbs: round6(Math.max(0, due - proceeds)),
    houseKeepsExcess: round6(Math.max(0, proceeds - due)),
    borrowerReceives: 0,
  };
}

// FIFO: oldest lender first. With a KYC registry, only approved lenders can join.
export class LenderQueue {
  #items = [];
  #kyc;
  constructor(kyc) {
    this.#kyc = kyc;
  }
  add(address) {
    if (!isAddress(address)) throw new Error("invalid address");
    if (this.#kyc && !this.#kyc.isApproved(address)) throw new Error("lender not KYC-approved");
    this.#items.push(address);
  }
  next() {
    return this.#items.shift();
  }
  get size() {
    return this.#items.length;
  }
}

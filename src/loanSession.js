import { randomUUID } from "node:crypto";

// In-memory only, same restart-tolerant style as IpGuard (src/guard.js): losing sessions on
// restart just means an in-flight quote must be re-requested. Keyed by a server-generated loanId
// so /loan/confirm cannot be used to bind an unrelated on-chain lock() call to someone else's
// loan, and so the settlement sweep (src/server.js) knows exactly which loan a lock belongs to.
export class LoanSessionStore {
  #sessions = new Map();

  create({
    lender, borrower, house, collateralSymbol, collateralToken, collateralAmountWei, principalWei, issuanceFeeWei, usdcDueWei,
    condition, fulfillment, finishAfter, cancelAfter, deadline,
  }) {
    const loanId = randomUUID();
    this.#sessions.set(loanId, {
      loanId, lender, borrower, house, collateralSymbol, collateralToken, collateralAmountWei, principalWei, issuanceFeeWei, usdcDueWei,
      condition, fulfillment, finishAfter, cancelAfter, deadline, lenderSignature: null,
      status: "pending_collateral", createdAt: Date.now(),
    });
    return loanId;
  }

  get(loanId) {
    return typeof loanId === "string" ? this.#sessions.get(loanId) : undefined;
  }

  setLenderSignature(loanId, signature) {
    const session = this.#sessions.get(loanId);
    if (!session || session.status !== "pending_collateral") return false;
    session.lenderSignature = signature;
    return true;
  }

  markLocked(loanId) {
    const session = this.#sessions.get(loanId);
    if (session) session.status = "collateral_locked";
  }

  markSettled(loanId) {
    const session = this.#sessions.get(loanId);
    if (session) session.status = "settled";
  }

  // Collateral locked, past finishAfter, not yet settled: the loan sessions the settlement sweep must act on.
  due(nowSeconds) {
    return [...this.#sessions.values()].filter(
      (s) => s.status === "collateral_locked" && nowSeconds >= s.finishAfter,
    );
  }

  // Unconfirmed sessions older than maxAgeMs are dropped; locked/settled ones are kept until settlement.
  sweep(maxAgeMs, now = Date.now()) {
    for (const [loanId, session] of this.#sessions) {
      if (session.status === "pending_collateral" && now - session.createdAt > maxAgeMs) {
        this.#sessions.delete(loanId);
      }
    }
  }

  get size() {
    return this.#sessions.size;
  }
}

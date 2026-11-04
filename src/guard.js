import { createHmac, randomBytes } from "node:crypto";
import { IP_WINDOW_MS, DAILY_LOAN_CAP } from "./params.js";

// Keyed fingerprints only: raw IPs are never stored, and the key lives in memory only.
export class IpGuard {
  #key = randomBytes(32);
  #validated = new Map();
  #loans = [];
  #now;

  constructor(now = Date.now) {
    this.#now = now;
  }

  #fingerprint(ip) {
    return createHmac("sha256", this.#key).update(String(ip)).digest("hex");
  }

  isBlocked(ip) {
    const until = this.#validated.get(this.#fingerprint(ip));
    return until !== undefined && until > this.#now();
  }

  markValidated(ip) {
    this.#validated.set(this.#fingerprint(ip), this.#now() + IP_WINDOW_MS);
    this.#loans.push(this.#now());
  }

  // Global cap: at most DAILY_LOAN_CAP confirmed loans in any rolling 24 h.
  dailyCapReached() {
    const cutoff = this.#now() - IP_WINDOW_MS;
    while (this.#loans.length && this.#loans[0] <= cutoff) this.#loans.shift();
    return this.#loans.length >= DAILY_LOAN_CAP;
  }

  sweep() {
    const now = this.#now();
    for (const [key, until] of this.#validated) {
      if (until <= now) this.#validated.delete(key);
    }
    if (typeof globalThis.gc === "function") globalThis.gc();
  }

  get size() {
    return this.#validated.size;
  }
}

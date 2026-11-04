import { createHmac, timingSafeEqual } from "node:crypto";
import { isAddress } from "../loan.js";

// Same isApproved(address) interface as KycRegistry (src/kyc.js), so LenderQueue and server.js
// don't need to know which KYC backend is in use. No jurisdiction/OFAC logic here by design: that
// screening is delegated entirely to Didit, not duplicated server-side.
export class DiditKycRegistry {
  #approved = new Set();

  approve(address) {
    if (isAddress(address)) this.#approved.add(address);
  }

  revoke(address) {
    this.#approved.delete(address);
  }

  isApproved(address) {
    return this.#approved.has(address);
  }

  get size() {
    return this.#approved.size;
  }
}

// TODO: confirm against Didit's dashboard docs once the account exists. This assumes an
// HMAC-SHA256 signature over the raw request body, hex-encoded, in a `x-didit-signature` header —
// a common webhook convention, NOT a verified Didit specification. Do not enable the webhook route
// below until this is checked against real docs and a real `secret`.
export function verifyDiditWebhookSignature(rawBody, signatureHeader, secret) {
  if (typeof signatureHeader !== "string" || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHeader, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// TODO: the field names below (`status`, `address`, decision values) are placeholders pending
// Didit's real webhook payload shape. Wire this into a POST /kyc/webhook route in server.js only
// after verifyDiditWebhookSignature is confirmed against real docs; KYC_FILE keeps working
// unchanged as a fallback until then.
export function applyDiditWebhook(kyc, payload) {
  if (!payload || typeof payload !== "object") return;
  const { address, status } = payload;
  if (!isAddress(address)) return;
  if (status === "approved") kyc.approve(address);
  else if (status === "revoked" || status === "declined") kyc.revoke(address);
}

import { randomBytes } from "node:crypto";
import { keccak256 } from "ethers";

// EVM analogue of the XRPL build's PREIMAGE-SHA-256 crypto-condition: fulfillment is a 32-byte
// preimage, condition is its keccak256 hash (the same hash LoanEscrow.sol checks in settle()).
// Simpler than XRPL's crypto-conditions binary (ASN.1) encoding -- no prefix/suffix needed.
export function createCollateralCondition() {
  const preimage = randomBytes(32);
  const condition = keccak256(preimage);
  const fulfillment = "0x" + preimage.toString("hex");
  return { condition, fulfillment };
}

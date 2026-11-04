import { Interface } from "ethers";
import { quote } from "../loan.js";
import { PRICE_MAX_DEVIATION, USDC_ADDRESS, USDC_DECIMALS } from "../params.js";
import { collateralUnits, escrowContract, loanIdFromString, loanRepaid } from "../chain.js";

const escrowInterface = new Interface([
  "event Settled(bytes32 indexed loanId, uint256 proceeds)",
]);

// Drives one loan's settlement at maturity. Unlike the XRPL sibling build, no fee wallet ever
// signs a sequence of value-moving transactions on this loan's behalf: the keeper key's only
// job is to pay gas for the contract's own, permissionless settle() call, which does the
// collateral->USDC swap and payout atomically on-chain (contracts/LoanEscrow.sol). Any address
// could call settle() in the keeper's place; this key holds no funds and has no special
// contract permission.
//
// Session status is mutated directly on the `session` object (the same object the caller's
// LoanSessionStore.due() returned, so this is the live stored session, not a copy): "settled" or
// "repaid_on_time" on success, "deficit_pending_approval" once a shortfall has been recorded
// on-chain for the house to pay via LoanEscrow.payDeficit() (a normal, house-triggered call --
// no separate sign-approval service needed, unlike the XRPL build's Xaman request). Both are
// terminal: LoanSessionStore.due() only re-offers sessions whose status is still
// "collateral_locked", so neither a settled nor a frozen loan is retried. If any step below
// throws before a terminal status is set, the session stays "collateral_locked" and the
// caller's sweep naturally retries it next cycle.
export async function runSettlement(session, { keeper, provider, priceProviders, dexDeadlineSeconds = 900 } = {}) {
  const { collateralSymbol, collateralToken, fulfillment } = session;
  const loanIdBytes32 = loanIdFromString(session.loanId);

  if (await loanRepaid(loanIdBytes32, provider)) {
    session.status = "repaid_on_time";
    return { outcome: "repaid_on_time" };
  }

  const priceProvider = priceProviders[collateralSymbol];
  const { price: stablePrice } = await priceProvider();
  const { principal, interest } = quote(1);
  const due = Math.round((principal + interest) * 1e6) / 1e6;

  const collateralAmount = Number(session.collateralAmountWei) / 1e18; // display-only; the contract already holds the exact wei amount
  const ceilingUsdc = collateralAmount * stablePrice;
  const floorUsdc = ceilingUsdc * (1 - PRICE_MAX_DEVIATION);
  const amountOutMinimumWei = collateralUnits(floorUsdc, USDC_DECIMALS);
  const path = [collateralToken, USDC_ADDRESS];
  const deadline = Math.floor(Date.now() / 1000) + dexDeadlineSeconds;

  const contract = escrowContract(keeper);
  const tx = await contract.settle(loanIdBytes32, fulfillment, amountOutMinimumWei, path, deadline);
  const receipt = await tx.wait();

  let proceedsWei = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = escrowInterface.parseLog(log);
      if (parsed?.name === "Settled" && parsed.args.loanId === loanIdBytes32) {
        proceedsWei = parsed.args.proceeds;
        break;
      }
    } catch {
      // not a Settled log from this contract; ignore
    }
  }
  const proceeds = Number(proceedsWei) / 10 ** USDC_DECIMALS;

  if (proceeds < due) {
    // The contract already paid the lender whatever it got and recorded the shortfall on-chain
    // (deficits[loanId]); the house calls payDeficit() itself, on its own schedule, from its own
    // wallet -- never an automated, unsupervised payment from this script.
    session.status = "deficit_pending_approval";
    return { outcome: "deficit_pending_approval", deficit: Math.round((due - proceeds) * 1e6) / 1e6 };
  }

  session.status = "settled";
  return { outcome: "settled", lenderReceives: due, houseKeepsExcess: Math.round((proceeds - due) * 1e6) / 1e6 };
}

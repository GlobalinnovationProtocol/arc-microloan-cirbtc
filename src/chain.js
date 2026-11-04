import { Contract, Interface, JsonRpcProvider, keccak256, parseUnits, toUtf8Bytes, Wallet } from "ethers";
import { ARC_CHAIN_ID, ARC_RPC_URL, ESCROW_CONTRACT_ADDRESS, USDC_ADDRESS } from "./params.js";

// Minimal ABI: only the pieces this server needs to encode calls and parse events/receipts.
// Mirrors contracts/LoanEscrow.sol exactly -- keep in sync if the contract changes.
export const ESCROW_ABI = [
  "function lock(bytes32 loanId, address collateralToken, uint256 collateralAmount, address lender, address house, uint256 usdcDue, bytes32 conditionHash, uint64 finishAfter, uint64 cancelAfter)",
  "function repay(bytes32 loanId)",
  "function settle(bytes32 loanId, bytes32 preimage, uint256 amountOutMinimum, address[] path, uint256 deadline)",
  "function payDeficit(bytes32 loanId)",
  "function cancel(bytes32 loanId)",
  "function loans(bytes32 loanId) view returns (address borrower, address lender, address house, address collateralToken, uint256 collateralAmount, uint256 usdcDue, bytes32 conditionHash, uint64 finishAfter, uint64 cancelAfter, uint8 status)",
  "event Locked(bytes32 indexed loanId, address indexed borrower, address indexed lender, address collateralToken, uint256 collateralAmount)",
  "event Repaid(bytes32 indexed loanId)",
  "event Settled(bytes32 indexed loanId, uint256 proceeds)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const escrowInterface = new Interface(ESCROW_ABI);
const erc20Interface = new Interface(ERC20_ABI);

export function getProvider(rpcUrl = ARC_RPC_URL) {
  if (!rpcUrl) throw new Error("ARC_RPC_URL not configured (see src/params.js)");
  return new JsonRpcProvider(rpcUrl, ARC_CHAIN_ID);
}

// Immutable time source: the latest block's timestamp (analogue of validated ledger close_time).
export async function latestBlockTime(provider) {
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("no latest block");
  return block.timestamp;
}

// Real pricing (a DEX pool read or an oracle call) is intentionally NOT implemented here: which
// price source actually exists on Arc for each of the five collateral/USDC pairs is unverified
// from this environment (see src/params.js DEX_ROUTER_ADDRESS). fetchImpl is injectable so tests
// never need a live chain; wiring a real source is a pre-mainnet TODO, same spirit as the other
// placeholders in src/params.js.
export async function bestCollateralPrice(tokenSymbol, fetchImpl) {
  if (!fetchImpl) throw new Error(`no price source configured for ${tokenSymbol} (see src/chain.js bestCollateralPrice)`);
  const price = await fetchImpl(tokenSymbol);
  if (!(price > 0)) throw new Error("invalid price");
  return price;
}

// Each call samples the price and the block time that goes with it, same pairing bestXrpPrice /
// validatedCloseTime had in the XRPL build's makePriceProvider.
export function makePriceProvider(tokenSymbol, provider, fetchImpl) {
  return async () => ({
    price: await bestCollateralPrice(tokenSymbol, fetchImpl),
    closeTime: await latestBlockTime(provider),
  });
}

// Unsigned calldata for the borrower's wallet to submit: first approve the collateral token,
// then call lock(). Two transactions because ERC-20 has no atomic "transfer with data" the
// contract can rely on generically across arbitrary tokens -- same two-step borrowers already
// expect from any ERC-20 contract interaction.
export function buildLockCalldata({
  loanId, collateralToken, collateralAmountWei, lender, house, usdcDueWei, conditionHash, finishAfter, cancelAfter,
  escrowAddress = ESCROW_CONTRACT_ADDRESS,
}) {
  return {
    approve: {
      to: collateralToken,
      data: erc20Interface.encodeFunctionData("approve", [escrowAddress, collateralAmountWei]),
    },
    lock: {
      to: escrowAddress,
      data: escrowInterface.encodeFunctionData("lock", [
        loanId, collateralToken, collateralAmountWei, lender, house, usdcDueWei, conditionHash, finishAfter, cancelAfter,
      ]),
    },
  };
}

// Unsigned calldata for on-time repayment: approve USDC, then call repay() (atomically pays the
// lender and returns the collateral -- see contracts/LoanEscrow.sol repay()).
export function buildRepaymentCalldata({ loanId, usdcDueWei, escrowAddress = ESCROW_CONTRACT_ADDRESS }) {
  return {
    approve: {
      to: USDC_ADDRESS,
      data: erc20Interface.encodeFunctionData("approve", [escrowAddress, usdcDueWei]),
    },
    repay: {
      to: escrowAddress,
      data: escrowInterface.encodeFunctionData("repay", [loanId]),
    },
  };
}

export function loanIdFromString(id) {
  return keccak256(toUtf8Bytes(id));
}

export function collateralUnits(amount, decimals) {
  return parseUnits(String(amount), decimals);
}

// Returns false unless this is a mined, successful lock() call for this exact loanId, binding
// the same collateral token, amount, lender and condition the session created at /loan/request
// (src/loanSession.js). Without this binding any mined lock() call, from anyone, could "confirm"
// any loan -- same role verifyCollateralEscrow played in the XRPL build's src/xrpl.js.
export async function verifyCollateralLock(txHash, expected, provider) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? "")) return false;
  if (!expected) return false;
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return false;
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = escrowInterface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed?.name !== "Locked") continue;
    const { loanId, borrower, lender, collateralToken, collateralAmount } = parsed.args;
    const ok =
      loanId === expected.loanId &&
      borrower === expected.borrower &&
      lender === expected.lender &&
      collateralToken === expected.collateralToken &&
      BigInt(collateralAmount) >= BigInt(expected.minCollateralAmount);
    if (ok) return true;
  }
  return false;
}

// Best-effort scan of recent Repaid events for this exact loanId -- the on-chain repay() call
// atomically pays the lender and returns collateral, so if this event exists the loan is already
// fully settled and the settlement sweep must not also attempt a default sale.
export async function loanRepaid(loanId, provider, { fromBlock = -5000, escrowAddress = ESCROW_CONTRACT_ADDRESS } = {}) {
  const latest = await provider.getBlockNumber();
  const from = fromBlock < 0 ? Math.max(0, latest + fromBlock) : fromBlock;
  const logs = await provider.getLogs({
    address: escrowAddress,
    topics: escrowInterface.encodeFilterTopics("Repaid", [loanId]),
    fromBlock: from,
    toBlock: latest,
  });
  return logs.length > 0;
}

export function loadKeeperWallet({
  privateKey = process.env.KEEPER_PRIVATE_KEY,
  provider,
} = {}) {
  if (!privateKey) throw new Error("KEEPER_PRIVATE_KEY required");
  return new Wallet(privateKey, provider);
}

export function escrowContract(signerOrProvider, address = ESCROW_CONTRACT_ADDRESS) {
  if (!address) throw new Error("ESCROW_CONTRACT_ADDRESS not configured (see src/params.js)");
  return new Contract(address, ESCROW_ABI, signerOrProvider);
}

const erc20MetaInterface = new Interface(["function decimals() view returns (uint8)"]);

// Fail fast at startup: a configured collateral address with no bytecode (or other decimals) on
// this chain would otherwise produce quotes against a token that can neither be locked nor sold.
export async function verifyCollateralTokens(tokens, provider) {
  for (const [symbol, token] of Object.entries(tokens)) {
    if (!token.address) continue;
    const code = await provider.getCode(token.address);
    if (code === "0x") throw new Error(`collateral ${symbol}: no contract at ${token.address} on this chain`);
    const raw = await provider.call({ to: token.address, data: erc20MetaInterface.encodeFunctionData("decimals") });
    const [decimals] = erc20MetaInterface.decodeFunctionResult("decimals", raw);
    if (Number(decimals) !== token.decimals) {
      throw new Error(`collateral ${symbol}: on-chain decimals ${decimals} != configured ${token.decimals}`);
    }
  }
}

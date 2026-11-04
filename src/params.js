export const PRINCIPAL_USDC = 1000;
export const ISSUANCE_FEE_RATE = 0.025;
export const LTV = 0.25;
export const TERM_DAYS = 42;
export const ANNUAL_INTEREST_RATE = 0.12;
export const PRICE_MAX_DEVIATION = 0.0025;
export const PRICE_MIN_INTERVAL_SECONDS = 60;
export const IP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DAILY_LOAN_CAP = 300;
export const CLEANUP_INTERVAL_MS = 300000;
export const MAX_BODY_BYTES = 4096;

// An unconfirmed loan session (quoted but collateral never locked) is dropped after this long.
export const LOAN_REQUEST_TTL_MS = 60 * 60 * 1000;
// Grace window between a collateral lock's finishAfter (loan maturity) and its cancelAfter.
export const ESCROW_GRACE_SECONDS = 3 * 24 * 60 * 60;

// Arc Mainnet network values verified from Circle's official Arc documentation.
// Sepolia is a separate testnet (chain ID 5042002), not the production network.
export const ARC_RPC_URL = process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io";
export const ARC_CHAIN_ID = 5042;
export const ARC_EXPLORER_TX_URL = "https://explorer.arc.io/tx/";

// Official Arc Mainnet USDC ERC-20 interface. It uses 6 decimals; native gas USDC
// uses a different 18-decimal representation.
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;

// The single deployed LoanEscrow contract (contracts/LoanEscrow.sol). Filled in after deployment.
export const ESCROW_CONTRACT_ADDRESS = "";

// A DEX router (or price-oracle) address with real on-chain liquidity/pricing for the single
// cirBTC/USDC pair.
export const DEX_ROUTER_ADDRESS = "";

// Single collateral: cirBTC, Circle-issued bitcoin on Arc (same proxy architecture as USDC/EURC).
// It is an ERC-20 on Arc (Arc's gas is USDC), so LoanEscrow's per-loan collateralToken parameter is
// simply always cirBTC. Addresses from docs.arc.io/arc/references/contract-addresses, both verified
// on-chain on 2026-11-03 (bytecode present, decimals() == 8, symbol() == "cirBTC"). Server startup
// re-verifies code and decimals (src/chain.js verifyCollateralTokens). One-entry map so the request
// shape (collateralSymbol: "cirBTC") and the token-configured checks are unchanged.
export const CIRBTC_MAINNET = "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0";
export const CIRBTC_TESTNET = "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF";
export const COLLATERAL_SYMBOL = "cirBTC";
export const COLLATERAL_TOKENS = {
  cirBTC: {
    address: process.env.CIRBTC_ADDRESS ?? CIRBTC_MAINNET,
    decimals: process.env.CIRBTC_DECIMALS ? Number(process.env.CIRBTC_DECIMALS) : 8,
  },
};

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { IpGuard } from "./guard.js";
import { KycRegistry } from "./kyc.js";
import { isAddress, priceIsStable, quote } from "./loan.js";
import { createCollateralCondition } from "./escrow.js";
import { LoanSessionStore } from "./loanSession.js";
import {
  ARC_CHAIN_ID, CLEANUP_INTERVAL_MS, COLLATERAL_SYMBOL, COLLATERAL_TOKENS, ESCROW_CONTRACT_ADDRESS, ESCROW_GRACE_SECONDS, LOAN_REQUEST_TTL_MS,
  MAX_BODY_BYTES, PRICE_MIN_INTERVAL_SECONDS, PRINCIPAL_USDC, TERM_DAYS, USDC_DECIMALS,
} from "./params.js";
import {
  buildLockCalldata, buildRepaymentCalldata, collateralUnits, fifoLenders as chainFifoLenders, getProvider,
  lenderLiquidity as chainLenderLiquidity, loadKeeperWallet, loanIdFromString, makePriceProvider,
  verifyCollateralLock, verifyCollateralTokens,
} from "./chain.js";
import { runSettlement as runLoanSettlement } from "./settlement/settle.js";
import { TERMS_TEXT, TERMS_VERSION, termsAccepted } from "./terms.js";


// process.env.TRUST_PROXY unset: identical to req.socket.remoteAddress (today's behavior). Set to a
// positive integer N: take the Nth-from-the-right X-Forwarded-For entry (the standard "N proxy hops
// trusted" rule), so a reverse-proxied deployment doesn't collapse every client onto the proxy's
// own IP for IpGuard's per-IP limits. Falls back to the socket address if the header is missing/malformed.
export function clientIp(req) {
  const hops = Number(process.env.TRUST_PROXY ?? 0);
  if (!(hops > 0)) return req.socket.remoteAddress;
  const header = req.headers["x-forwarded-for"];
  if (typeof header !== "string") return req.socket.remoteAddress;
  const parts = header.split(",").map((s) => s.trim()).filter(Boolean);
  const index = parts.length - hops;
  return parts[index] ?? req.socket.remoteAddress;
}

// Common secret field names are refused outright on every route. The 64-hex-char shape (a
// private key) is only checked on /loan/request: /loan/confirm legitimately carries a 32-byte
// txHash in that same shape, so applying it there would reject real confirmations.
const SECRET_WORD_PATTERN = /secret|seed|private|mnemonic/i;
const SECRET_HEX_PATTERN = /\b0x[0-9A-Fa-f]{64}\b/;

function reply(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

export function createLoanServer({
  house, kyc, guard = new IpGuard(), priceProviders = {}, verifyLock,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  sessions = new LoanSessionStore(), runSettlement,
  escrowAddress = ESCROW_CONTRACT_ADDRESS,
  lenderLiquidity = null, fifoLenders = null,
} = {}) {
  if (!isAddress(house)) throw new Error("house address required");
  if (!kyc) throw new Error("KYC registry required in the KYC build");

  const server = createServer((req, res) => {
    const ip = clientIp(req);
    let chunks = [];
    const wipe = () => {
      chunks = [];
    };
    res.on("close", wipe);

    if (req.method === "GET" && req.url === "/health") {
      req.resume();
      return reply(res, 200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/terms") {
      req.resume();
      return reply(res, 200, { version: TERMS_VERSION, text: TERMS_TEXT });
    }
    const route = req.url;
    if (req.method !== "POST" || (route !== "/loan/request" && route !== "/loan/confirm")) {
      req.resume();
      return reply(res, 404, { error: "not found" });
    }

    if (guard.isBlocked(ip)) {
      req.destroy();
      return res.destroy();
    }
    if (route === "/loan/request" && guard.dailyCapReached()) {
      req.resume();
      return reply(res, 503, { error: "daily loan capacity reached" });
    }

    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        wipe();
        req.destroy();
        return res.destroy();
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        wipe();
        if (SECRET_WORD_PATTERN.test(raw) || (route !== "/loan/confirm" && SECRET_HEX_PATTERN.test(raw))) {
          return reply(res, 400, { error: "secrets are never accepted" });
        }
        const body = JSON.parse(raw);

        if (route === "/loan/confirm") {
          if (!verifyLock) return reply(res, 503, { error: "lock verification not configured" });
          const session = sessions.get(body.loanId);
          if (!session) return reply(res, 409, { error: "collateral lock not validated" });
          const verified = await verifyLock(body.txHash, session);
          if (!verified) return reply(res, 409, { error: "collateral lock not validated" });
          guard.markValidated(ip);
          sessions.markLocked(body.loanId);
          return reply(res, 200, { confirmed: true, loanId: body.loanId });
        }

        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return reply(res, 400, { error: "bad request" });
        }
        if (!termsAccepted(body)) {
          return reply(res, 403, { error: "terms of use must be accepted by lender and borrower", termsVersion: TERMS_VERSION });
        }
        const { borrower, collateralSymbol = COLLATERAL_SYMBOL } = body;
        let { lender } = body;
        if (!isAddress(borrower) || (lender !== undefined && (!isAddress(lender) || lender === borrower))) {
          return reply(res, 400, { error: "invalid addresses" });
        }
        if (!kyc.isApproved(borrower) || (lender !== undefined && !kyc.isApproved(lender))) {
          return reply(res, 403, { error: "KYC approval required for lender and borrower" });
        }
        const token = COLLATERAL_TOKENS[collateralSymbol];
        if (!token) return reply(res, 400, { error: "unknown collateral symbol" });
        if (!token.address || !token.decimals) {
          return reply(res, 503, { error: `collateral token ${collateralSymbol} not configured yet` });
        }
        if (!escrowAddress) return reply(res, 503, { error: "escrow contract not configured yet" });
        if (!lenderLiquidity) return reply(res, 503, { error: "lender liquidity source not configured" });
        const priceProvider = priceProviders[collateralSymbol];
        if (!priceProvider) return reply(res, 503, { error: "price source not configured" });

        const principalWei = collateralUnits(PRINCIPAL_USDC, USDC_DECIMALS);
        if (lender === undefined) {
          if (!fifoLenders) return reply(res, 503, { error: "FIFO lender source not configured" });
          for (const candidate of await fifoLenders()) {
            if (candidate === borrower || !kyc.isApproved(candidate)) continue;
            if ((await lenderLiquidity(candidate, principalWei)).ok) { lender = candidate; break; }
          }
          if (!lender) return reply(res, 409, { error: `no KYC-approved lender with ${PRINCIPAL_USDC} USDC approved and available` });
        } else if (!(await lenderLiquidity(lender, principalWei)).ok) {
          return reply(res, 409, { error: `lender has not approved, or does not hold, the ${PRINCIPAL_USDC} USDC principal` });
        }

        const first = await priceProvider();
        let second = await priceProvider();
        for (let i = 0; i < 24 && second.closeTime - first.closeTime < PRICE_MIN_INTERVAL_SECONDS; i++) {
          await sleep(5000);
          second = await priceProvider();
        }
        if (!priceIsStable(first, second)) return reply(res, 409, { error: "price not stable" });

        const terms = quote(second.price);
        const { condition, fulfillment } = createCollateralCondition();
        const collateralAmountWei = collateralUnits(terms.collateralAmount, token.decimals);
        const issuanceFeeWei = collateralUnits(terms.issuanceFee, USDC_DECIMALS);
        const usdcDueWei = collateralUnits(terms.principal + terms.interest, USDC_DECIMALS);
        const finishAfter = second.closeTime + TERM_DAYS * 24 * 60 * 60;
        const cancelAfter = finishAfter + ESCROW_GRACE_SECONDS;
        const loanId = sessions.create({
          lender, borrower, house, collateralSymbol, collateralToken: token.address, collateralAmountWei, usdcDueWei,
          condition, fulfillment, finishAfter, cancelAfter,
        });
        return reply(res, 200, {
          loanId,
          lender,
          terms: { ...terms, collateralSymbol },
          unsigned: {
            ...buildLockCalldata({
              loanId: loanIdFromString(loanId), collateralToken: token.address, collateralAmountWei,
              lender, house, principalWei, issuanceFeeWei, usdcDueWei,
              conditionHash: condition, finishAfter, cancelAfter, escrowAddress,
            }),
            repay: buildRepaymentCalldata({ loanId: loanIdFromString(loanId), usdcDueWei, escrowAddress }),
          },
        });
      } catch {
        return reply(res, 400, { error: "bad request" });
      }
    });
  });

  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      guard.sweep();
      sessions.sweep(LOAN_REQUEST_TTL_MS);
      if (runSettlement) {
        const anyProvider = Object.values(priceProviders)[0];
        if (anyProvider) {
          const { closeTime } = await anyProvider();
          for (const session of sessions.due(closeTime)) {
            try {
              // runSettlement mutates session.status itself (settled / repaid_on_time /
              // deficit_pending_approval) on the live session object; due() only re-offers
              // "collateral_locked" sessions, so a terminal status is never retried, and a
              // thrown error leaves the status untouched so the next sweep retries it.
              await runSettlement(session);
            } catch {
              // left collateral_locked: the next sweep retries this loan's settlement.
            }
          }
        }
      }
    } finally {
      sweeping = false;
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return server;
}

async function main() {
  const provider = getProvider();
  const actualChainId = BigInt(await provider.send("eth_chainId", []));
  if (actualChainId !== BigInt(ARC_CHAIN_ID)) {
    throw new Error(`wrong Arc network: expected chain ${ARC_CHAIN_ID}, got ${actualChainId}`);
  }
  await verifyCollateralTokens(COLLATERAL_TOKENS, provider);
  const priceProviders = Object.fromEntries(
    Object.keys(COLLATERAL_TOKENS).map((symbol) => [symbol, makePriceProvider(symbol, provider)]),
  );

  // Settlement automation only comes online once a keeper key is actually provisioned -- a
  // manual, pre-mainnet step. The keeper holds no funds and no special contract permission: it
  // only pays gas to call the permissionless settle()/repay()-adjacent sweep (see
  // contracts/LoanEscrow.sol and src/settlement/settle.js). Until then the server runs exactly
  // as before: quoting, confirming locks, no automated settlement sweep.
  let runSettlement;
  if (process.env.KEEPER_PRIVATE_KEY) {
    const keeper = loadKeeperWallet({ provider });
    runSettlement = (session) => runLoanSettlement(session, { keeper, provider, priceProviders });
  }

  createLoanServer({
    house: process.env.HOUSE_ADDRESS,
    kyc: KycRegistry.fromFile(process.env.KYC_FILE ?? "kyc-approved.txt"),
    priceProviders,
    verifyLock: (hash, session) => verifyCollateralLock(hash, {
      loanId: loanIdFromString(session.loanId), borrower: session.borrower, lender: session.lender,
      collateralToken: session.collateralToken, minCollateralAmount: session.collateralAmountWei,
    }, provider),
    lenderLiquidity: (lender, principalWei) => chainLenderLiquidity(lender, principalWei, provider),
    fifoLenders: () => chainFifoLenders(provider, ESCROW_CONTRACT_ADDRESS, { fromBlock: Number(process.env.ESCROW_DEPLOY_BLOCK ?? 0) }),
    runSettlement,
  }).listen(Number(process.env.PORT ?? 8080), "127.0.0.1");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

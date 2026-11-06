import { expect } from "chai";
import hre from "hardhat";
import { LOAN_TERMS_TYPES } from "../../src/chain.js";

const { ethers } = hre;

async function deployFixture() {
  const [deployer, borrower, lender, house, keeper] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("Mock USDC", "mUSDC", 6);
  const collateral = await MockERC20.deploy("Mock cirBTC", "mcirBTC", 8);

  const MockDexRouter = await ethers.getContractFactory("MockDexRouter");
  const router = await MockDexRouter.deploy();

  const LoanEscrow = await ethers.getContractFactory("LoanEscrow");
  const escrow = await LoanEscrow.deploy(await usdc.getAddress(), await router.getAddress(), await house.getAddress(), await collateral.getAddress());

  // Fund the router so it can pay out swap proceeds, and the borrower/lender/house with what they need.
  await usdc.mint(await router.getAddress(), ethers.parseUnits("1000000", 6));
  await collateral.mint(await borrower.getAddress(), ethers.parseUnits("10000", 8));
  await usdc.mint(await borrower.getAddress(), ethers.parseUnits("10000", 6));
  await usdc.mint(await lender.getAddress(), ethers.parseUnits("10000", 6));
  await usdc.mint(await house.getAddress(), ethers.parseUnits("10000", 6));

  return { deployer, borrower, lender, house, keeper, usdc, collateral, router, escrow };
}

const DAY = 24 * 60 * 60;
const RATE_SCALE = 10n ** 10n; // 18 - 8 decimals (see MockDexRouter rate convention)
const START = ethers.parseUnits("10000", 6);       // USDC each party starts with
const PRINCIPAL = ethers.parseUnits("1000", 6);
const FEE = ethers.parseUnits("25", 6);

function loanId(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function condition() {
  const preimage = ethers.randomBytes(32);
  const hash = ethers.keccak256(preimage);
  return { preimage: ethers.hexlify(preimage), hash };
}

async function signedTerms({ escrow, borrower, lender }, { id, collateralAmount, usdcDue, principal = PRINCIPAL, fee = FEE, finishIn = DAY, cancelGrace = 3 * DAY, deadlineIn = DAY, signer = lender, lenderAddress }) {
  const { preimage, hash } = condition();
  const now = await ethers.provider.getBlock("latest").then((b) => b.timestamp);
  const finishAfter = now + finishIn;
  const cancelAfter = finishAfter + cancelGrace;
  const terms = {
    loanId: id, borrower: await borrower.getAddress(), lender: lenderAddress ?? await lender.getAddress(), collateralAmount,
    principal, issuanceFee: fee, usdcDue, conditionHash: hash, finishAfter, cancelAfter, deadline: now + deadlineIn,
  };
  const domain = { name: "LoanEscrow", version: "3", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await escrow.getAddress() };
  const signature = await signer.signTypedData(domain, LOAN_TERMS_TYPES, terms);
  return { terms, signature, preimage, finishAfter, cancelAfter };
}

async function lockLoan(f, options) {
  const { escrow, collateral, usdc, borrower, lender } = f;
  const { terms, signature, preimage, finishAfter, cancelAfter } = await signedTerms(f, options);
  if (options.lenderApproves ?? true) await usdc.connect(lender).approve(await escrow.getAddress(), terms.principal);
  await collateral.connect(borrower).approve(await escrow.getAddress(), terms.collateralAmount);
  const tx = escrow.connect(borrower).lock(terms, options.signature ?? signature);
  return { preimage, finishAfter, cancelAfter, tx, terms, signature };
}

describe("LoanEscrow", () => {
  it("lock funds the loan atomically: collateral in, principal-fee to the borrower, fee to the house, all from the lender's allowance", async () => {
    const f = await deployFixture();
    const id = loanId("fund-1");
    const collateralAmount = ethers.parseUnits("2000", 8);
    const usdcDue = ethers.parseUnits("1013.808219", 6);
    const { tx } = await lockLoan(f, { id, collateralAmount, usdcDue });
    await expect(tx).to.emit(f.escrow, "Funded").withArgs(id, await f.lender.getAddress(), PRINCIPAL, FEE);

    expect(await f.usdc.balanceOf(await f.lender.getAddress())).to.equal(START - PRINCIPAL);
    expect(await f.usdc.balanceOf(await f.borrower.getAddress())).to.equal(START + PRINCIPAL - FEE);
    expect(await f.usdc.balanceOf(await f.house.getAddress())).to.equal(START + FEE);
    expect(await f.collateral.balanceOf(await f.escrow.getAddress())).to.equal(collateralAmount);
  });

  it("lock reverts as a whole when the lender has not approved (or moved out) the principal: no collateral leaves the borrower", async () => {
    const f = await deployFixture();
    const id = loanId("unfunded-1");
    const collateralAmount = ethers.parseUnits("2000", 8);
    const usdcDue = ethers.parseUnits("1013.808219", 6);

    const noAllowance = await lockLoan(f, { id, collateralAmount, usdcDue, lenderApproves: false });
    await expect(noAllowance.tx).to.be.revertedWith("transferFrom failed");

    await f.usdc.connect(f.lender).approve(await f.escrow.getAddress(), PRINCIPAL);
    await f.usdc.connect(f.lender).transfer(await f.keeper.getAddress(), START - ethers.parseUnits("500", 6)); // only 500 left
    const noBalance = await lockLoan(f, { id, collateralAmount, usdcDue, lenderApproves: false });
    await expect(noBalance.tx).to.be.revertedWith("transferFrom failed");

    expect(await f.collateral.balanceOf(await f.borrower.getAddress())).to.equal(ethers.parseUnits("10000", 8));
    expect(await f.collateral.balanceOf(await f.escrow.getAddress())).to.equal(0n);
    expect(Number((await f.escrow.loans(id)).status)).to.equal(0 /* None */);
  });

  it("lock rejects a fee above the principal, a due below the principal, and lender == borrower", async () => {
    const f = await deployFixture();
    const collateralAmount = ethers.parseUnits("2000", 8);
    const usdcDue = ethers.parseUnits("1013.808219", 6);
    await expect((await lockLoan(f, { id: loanId("fee-1"), collateralAmount, usdcDue, fee: PRINCIPAL })).tx).to.be.revertedWith("bad principal");
    await expect((await lockLoan(f, { id: loanId("due-1"), collateralAmount, usdcDue: PRINCIPAL - 1n })).tx).to.be.revertedWith("bad principal");
    await expect((await lockLoan({ ...f, lender: f.borrower }, { id: loanId("self-1"), collateralAmount, usdcDue })).tx).to.be.revertedWith("bad lender");
  });

  it("nobody can spend a lender's allowance without the lender's signature over these exact terms (external report 2026-11-06)", async () => {
    const f = await deployFixture();
    const collateralAmount = 1n; // the attack: worthless collateral, real lender allowance
    const usdcDue = PRINCIPAL;
    await f.usdc.connect(f.lender).approve(await f.escrow.getAddress(), PRINCIPAL);

    // 1. Attacker (the borrower here) signs as themselves but names the lender: wrong signer.
    const forged = await lockLoan(f, { id: loanId("forge-1"), collateralAmount, usdcDue, signer: f.borrower, lenderApproves: false });
    await expect(forged.tx).to.be.revertedWith("bad lender signature");

    // 2. A genuine lender signature for OTHER terms (different loanId) cannot be replayed.
    const genuine = await signedTerms(f, { id: loanId("real-1"), collateralAmount, usdcDue });
    const replay = await lockLoan(f, { id: loanId("replay-1"), collateralAmount, usdcDue, signature: genuine.signature, lenderApproves: false });
    await expect(replay.tx).to.be.revertedWith("bad lender signature");

    // 3. Someone other than terms.borrower cannot submit the lender-signed terms.
    const stolen = await signedTerms(f, { id: loanId("stolen-1"), collateralAmount, usdcDue });
    await expect(f.escrow.connect(f.keeper).lock(stolen.terms, stolen.signature)).to.be.revertedWith("borrower must lock");

    // 4. Expired terms are refused even with a valid signature.
    const expired = await lockLoan(f, { id: loanId("expired-1"), collateralAmount, usdcDue, deadlineIn: -1, lenderApproves: false });
    await expect(expired.tx).to.be.revertedWith("terms expired");

    expect(await f.usdc.balanceOf(await f.lender.getAddress())).to.equal(START, "lender's USDC untouched");
    expect(await f.usdc.balanceOf(await f.borrower.getAddress())).to.equal(START);
  });

  it("house and collateral token are fixed at deployment: lock() has no parameter to redirect fees or pass a foreign token", async () => {
    const f = await deployFixture();
    expect(await f.escrow.house()).to.equal(await f.house.getAddress());
    expect(await f.escrow.collateralToken()).to.equal(await f.collateral.getAddress());
    const lockFragment = f.escrow.interface.getFunction("lock");
    const termFields = lockFragment.inputs[0].components.map((c) => c.name);
    expect(termFields).to.not.include("house");
    expect(termFields).to.not.include("collateralToken");
  });

  it("lock -> repay: lender is paid, collateral returns to the borrower, status is terminal", async () => {
    const f = await deployFixture();
    const id = loanId("repay-1");
    const collateralAmount = ethers.parseUnits("2000", 8);
    const usdcDue = ethers.parseUnits("1013.808219", 6);
    await (await lockLoan(f, { id, collateralAmount, usdcDue })).tx;

    await f.usdc.connect(f.borrower).approve(await f.escrow.getAddress(), usdcDue);
    await expect(f.escrow.connect(f.borrower).repay(id)).to.emit(f.escrow, "Repaid").withArgs(id);

    expect(await f.usdc.balanceOf(await f.lender.getAddress())).to.equal(START - PRINCIPAL + usdcDue);
    expect(await f.collateral.balanceOf(await f.borrower.getAddress())).to.equal(ethers.parseUnits("10000", 8));

    await expect(f.escrow.connect(f.borrower).repay(id)).to.be.revertedWith("not locked");
  });

  it("lock -> default -> settle with excess: lender made whole, house receives the surplus", async () => {
    const f = await deployFixture();
    // MockDexRouter computes amountOut = amountIn * rate / 1e18. Collateral (cirBTC) is 8-decimal,
    // so the rate is scaled by 1e10 (RATE_SCALE) for "rate" to still mean USDC per whole collateral unit;
    // USDC is 6-decimal, so the rate must be scaled to the *output* token's decimals (1e6),
    // not 1e18, for "rate" to mean "USDC per whole collateral unit".
    await f.router.setRate(ethers.parseUnits("2", 6) * RATE_SCALE); // 1 collateral -> 2 USDC
    const id = loanId("default-excess-1");
    const collateralAmount = ethers.parseUnits("2000", 8); // worth 4000 USDC at rate 2
    const usdcDue = ethers.parseUnits("1013.808219", 6);
    const { preimage, finishAfter, tx } = await lockLoan(f, { id, collateralAmount, usdcDue });
    await tx;

    await ethers.provider.send("evm_setNextBlockTimestamp", [finishAfter + 1]);
    await ethers.provider.send("evm_mine", []);

    const path = [await f.collateral.getAddress(), await f.usdc.getAddress()];
    const deadline = finishAfter + DAY;
    await expect(f.escrow.connect(f.keeper).settle(id, preimage, 0n, path, deadline))
      .to.emit(f.escrow, "Settled");

    expect(await f.usdc.balanceOf(await f.lender.getAddress())).to.equal(START - PRINCIPAL + usdcDue);
    const expectedProceeds = ethers.parseUnits("4000", 6);
    const expectedExcess = expectedProceeds - usdcDue;
    expect(await f.usdc.balanceOf(await f.house.getAddress())).to.equal(START + FEE + expectedExcess);
    expect(await f.escrow.deficits(id)).to.equal(0n);
  });

  it("lock -> default -> settle with deficit -> payDeficit: lender gets the shortfall only when the house pays it", async () => {
    const f = await deployFixture();
    await f.router.setRate(ethers.parseUnits("0.1", 6) * RATE_SCALE); // 1 collateral -> 0.1 USDC (collapsed price)
    const id = loanId("default-deficit-1");
    const collateralAmount = ethers.parseUnits("2000", 8); // worth 200 USDC at rate 0.1
    const usdcDue = ethers.parseUnits("1013.808219", 6);
    const { preimage, finishAfter, tx } = await lockLoan(f, { id, collateralAmount, usdcDue });
    await tx;

    await ethers.provider.send("evm_setNextBlockTimestamp", [finishAfter + 1]);
    await ethers.provider.send("evm_mine", []);

    const path = [await f.collateral.getAddress(), await f.usdc.getAddress()];
    await expect(f.escrow.connect(f.keeper).settle(id, preimage, 0n, path, finishAfter + DAY))
      .to.emit(f.escrow, "DeficitRecorded");

    const proceeds = ethers.parseUnits("200", 6);
    expect(await f.usdc.balanceOf(await f.lender.getAddress())).to.equal(START - PRINCIPAL + proceeds);
    const shortfall = usdcDue - proceeds;
    expect(await f.escrow.deficits(id)).to.equal(shortfall);

    await expect(f.escrow.connect(f.borrower).payDeficit(id)).to.be.revertedWith("only house");

    await f.usdc.connect(f.house).approve(await f.escrow.getAddress(), shortfall);
    await expect(f.escrow.connect(f.house).payDeficit(id)).to.emit(f.escrow, "DeficitPaid").withArgs(id, shortfall);
    expect(await f.usdc.balanceOf(await f.lender.getAddress())).to.equal(START - PRINCIPAL + usdcDue);
    expect(await f.escrow.deficits(id)).to.equal(0n);

    await expect(f.escrow.connect(f.house).payDeficit(id)).to.be.revertedWith("no deficit");
  });

  it("lock -> cancel: an unsettled loan's collateral returns to the (defaulting) borrower after cancelAfter -- the disclosed limitation", async () => {
    const f = await deployFixture();
    const id = loanId("cancel-1");
    const collateralAmount = ethers.parseUnits("2000", 8);
    const usdcDue = ethers.parseUnits("1013.808219", 6);
    const { cancelAfter, tx } = await lockLoan(f, { id, collateralAmount, usdcDue });
    await tx;

    await expect(f.escrow.cancel(id)).to.be.revertedWith("too early");

    await ethers.provider.send("evm_setNextBlockTimestamp", [cancelAfter + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(f.escrow.cancel(id)).to.emit(f.escrow, "Cancelled").withArgs(id);
    expect(await f.collateral.balanceOf(await f.borrower.getAddress())).to.equal(ethers.parseUnits("10000", 8));
    await expect(f.escrow.cancel(id)).to.be.revertedWith("not locked");
  });

  it("settle() rejects a loan that has not yet matured, a wrong preimage, and a path not ending in USDC", async () => {
    const f = await deployFixture();
    const id = loanId("guard-1");
    const collateralAmount = ethers.parseUnits("2000", 8);
    const usdcDue = ethers.parseUnits("1013.808219", 6);
    const { preimage, finishAfter, tx } = await lockLoan(f, { id, collateralAmount, usdcDue });
    await tx;

    const path = [await f.collateral.getAddress(), await f.usdc.getAddress()];
    await expect(f.escrow.settle(id, preimage, 0n, path, finishAfter + DAY)).to.be.revertedWith("not matured");

    await ethers.provider.send("evm_setNextBlockTimestamp", [finishAfter + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(f.escrow.settle(id, ethers.hexlify(ethers.randomBytes(32)), 0n, path, finishAfter + DAY))
      .to.be.revertedWith("bad preimage");
    await expect(f.escrow.settle(id, preimage, 0n, [await f.collateral.getAddress(), await f.collateral.getAddress()], finishAfter + DAY))
      .to.be.revertedWith("bad path");
  });

  it("a second lock() with the same loanId is refused (no overwrite of an in-flight loan)", async () => {
    const f = await deployFixture();
    const id = loanId("dup-1");
    const collateralAmount = ethers.parseUnits("2000", 8);
    const usdcDue = ethers.parseUnits("1013.808219", 6);
    await (await lockLoan(f, { id, collateralAmount, usdcDue })).tx;

    await f.collateral.mint(await f.borrower.getAddress(), collateralAmount);
    const again = await lockLoan(f, { id, collateralAmount, usdcDue });
    await expect(again.tx).to.be.revertedWith("loan exists");
  });
});

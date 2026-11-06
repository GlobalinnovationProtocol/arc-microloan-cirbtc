// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal non-custodial collateral escrow for one fixed-term micro-loan product.
/// USDC is the loan currency; the collateral token (cirBTC) and the house address are fixed at
/// deployment, so this single, non-upgradeable, admin-free contract covers exactly one product.
///
/// Design choices, deliberately minimizing attack surface:
/// - No admin key, no owner, no pausability, no upgradeability: a bug needs a new deployment,
///   not a patch -- a disclosed tradeoff in exchange for nothing here ever being able to
///   rug/freeze/redirect funds after audit.
/// - lock() moves the collateral AND the lender's funding in one transaction, so a loan can never
///   exist half-done. Because the lender's USDC allowance to this contract is what gets pulled, the
///   lender must have SIGNED these exact loan terms (EIP-712): nobody can name a lender they do not
///   control, nor spend a lender's allowance on terms the lender never saw. (External report,
///   2026-11-06: v2 accepted `lender` as a bare parameter -- fixed here.)
/// - house and collateralToken are immutable: fees cannot be redirected and no foreign token can
///   be passed as collateral by calling the contract directly.
/// - settle() is permissionless: any address (a keeper bot, the lender, anyone) can trigger
///   default settlement once finishAfter has passed, paying their own gas. No operator hot
///   wallet ever custodies loan funds in the common path.
/// - repay() is on-chain and atomic: the borrower's principal+interest transfer to the lender
///   and the collateral's return happen in the same transaction, so there is no off-chain
///   "did they actually repay" check to trust.
/// - A default shortfall is never auto-paid from the house's balance: it is recorded on-chain
///   and payDeficit() is a normal, house-triggered call made whenever the house reviews and
///   approves it -- the human-in-the-loop control, with no separate sign-approval service needed.
/// - cancel() is a disclosed, deliberate limitation carried over from this project's XRPL
///   sibling: if nobody calls settle() before cancelAfter, collateral returns to the
///   borrower who defaulted, not to the house. The lender signs conditionHash as part of the
///   terms, so a borrower alone cannot pick a hash with no known preimage to force that path.
contract LoanEscrow {
    enum Status {
        None,
        Locked,
        Repaid,
        Settled,
        Cancelled
    }

    struct Loan {
        address borrower;
        address lender;
        uint256 collateralAmount;
        uint256 usdcDue; // principal + interest, fixed at lock time
        bytes32 conditionHash; // keccak256(preimage); mirrors the XRPL build's PREIMAGE-SHA-256 condition
        uint64 finishAfter; // loan maturity (unix seconds)
        uint64 cancelAfter; // grace-window fallback (unix seconds)
        Status status;
    }

    /// Exact terms the lender signs (EIP-712). loanId is unique per loan (replay-safe together with
    /// the status check); deadline bounds how long the signature stays usable.
    struct LoanTerms {
        bytes32 loanId;
        address borrower;
        address lender;
        uint256 collateralAmount;
        uint256 principal;
        uint256 issuanceFee;
        uint256 usdcDue;
        bytes32 conditionHash;
        uint64 finishAfter;
        uint64 cancelAfter;
        uint256 deadline;
    }

    bytes32 public constant LOAN_TERMS_TYPEHASH = keccak256(
        "LoanTerms(bytes32 loanId,address borrower,address lender,uint256 collateralAmount,uint256 principal,uint256 issuanceFee,uint256 usdcDue,bytes32 conditionHash,uint64 finishAfter,uint64 cancelAfter,uint256 deadline)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    IERC20 public immutable usdc;
    IDexRouter public immutable dexRouter;
    address public immutable house;
    address public immutable collateralToken;

    mapping(bytes32 => Loan) public loans;
    mapping(bytes32 => uint256) public deficits;

    bool private _entered;

    event Locked(bytes32 indexed loanId, address indexed borrower, address indexed lender, address collateralToken, uint256 collateralAmount);
    event Funded(bytes32 indexed loanId, address indexed lender, uint256 principal, uint256 issuanceFee);
    event Repaid(bytes32 indexed loanId);
    event Settled(bytes32 indexed loanId, uint256 proceeds);
    event DeficitRecorded(bytes32 indexed loanId, uint256 amount);
    event DeficitPaid(bytes32 indexed loanId, uint256 amount);
    event Cancelled(bytes32 indexed loanId);

    modifier nonReentrant() {
        require(!_entered, "reentrant");
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address usdcAddress, address dexRouterAddress, address houseAddress, address collateralTokenAddress) {
        require(
            usdcAddress != address(0) && dexRouterAddress != address(0) && houseAddress != address(0) && collateralTokenAddress != address(0),
            "zero address"
        );
        require(collateralTokenAddress != usdcAddress, "collateral is usdc");
        usdc = IERC20(usdcAddress);
        dexRouter = IDexRouter(dexRouterAddress);
        house = houseAddress;
        collateralToken = collateralTokenAddress;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("LoanEscrow"),
                keccak256("3"),
                block.chainid,
                address(this)
            )
        );
    }

    function hashLoanTerms(LoanTerms calldata t) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                LOAN_TERMS_TYPEHASH, t.loanId, t.borrower, t.lender, t.collateralAmount, t.principal, t.issuanceFee,
                t.usdcDue, t.conditionHash, t.finishAfter, t.cancelAfter, t.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// Borrower (t.borrower == msg.sender) locks collateral and the lender's funding settles in the
    /// same transaction. The borrower must have approved t.collateralAmount of collateralToken and the
    /// lender t.principal USDC to this contract, and lenderSignature must be the lender's EIP-712
    /// signature over exactly these terms. principal - issuanceFee goes to the borrower, issuanceFee
    /// to the house. If any leg fails the whole call reverts.
    function lock(LoanTerms calldata t, bytes calldata lenderSignature) external nonReentrant {
        require(loans[t.loanId].status == Status.None, "loan exists");
        require(t.borrower == msg.sender, "borrower must lock");
        require(t.lender != address(0) && t.lender != msg.sender, "bad lender");
        require(t.collateralAmount > 0 && t.usdcDue > 0, "zero amount");
        require(t.principal > t.issuanceFee && t.usdcDue >= t.principal, "bad principal");
        require(block.timestamp <= t.deadline, "terms expired");
        require(t.finishAfter > block.timestamp, "finishAfter in the past");
        require(t.cancelAfter > t.finishAfter, "cancelAfter must follow finishAfter");
        require(_recover(hashLoanTerms(t), lenderSignature) == t.lender, "bad lender signature");

        loans[t.loanId] = Loan({
            borrower: msg.sender,
            lender: t.lender,
            collateralAmount: t.collateralAmount,
            usdcDue: t.usdcDue,
            conditionHash: t.conditionHash,
            finishAfter: t.finishAfter,
            cancelAfter: t.cancelAfter,
            status: Status.Locked
        });

        _safeTransferFrom(collateralToken, msg.sender, address(this), t.collateralAmount);
        _safeTransferFrom(address(usdc), t.lender, msg.sender, t.principal - t.issuanceFee);
        _safeTransferFrom(address(usdc), t.lender, house, t.issuanceFee);
        emit Locked(t.loanId, msg.sender, t.lender, collateralToken, t.collateralAmount);
        emit Funded(t.loanId, t.lender, t.principal, t.issuanceFee);
    }

    /// On-time repayment: borrower pays principal + interest to the lender and gets collateral
    /// back, atomically, in one call. Caller must have approved this contract for usdcDue USDC.
    function repay(bytes32 loanId) external nonReentrant {
        Loan storage l = loans[loanId];
        require(l.status == Status.Locked, "not locked");
        require(msg.sender == l.borrower, "only borrower");
        require(block.timestamp <= l.finishAfter, "term over");

        l.status = Status.Repaid;
        _safeTransferFrom(address(usdc), msg.sender, l.lender, l.usdcDue);
        _safeTransfer(collateralToken, l.borrower, l.collateralAmount);
        emit Repaid(loanId);
    }

    /// Permissionless default settlement: anyone may call this once finishAfter has passed,
    /// supplying the preimage and a DEX route. amountOutMinimum is this call's DeliverMin-style
    /// floor -- the swap reverts rather than silently underfill. The caller (a keeper bot, the
    /// lender, anyone) pays their own gas and gains no special custody or privilege.
    function settle(
        bytes32 loanId,
        bytes32 preimage,
        uint256 amountOutMinimum,
        address[] calldata path,
        uint256 deadline
    ) external nonReentrant {
        Loan storage l = loans[loanId];
        require(l.status == Status.Locked, "not locked");
        require(block.timestamp >= l.finishAfter, "not matured");
        require(keccak256(abi.encodePacked(preimage)) == l.conditionHash, "bad preimage");
        require(path.length >= 2 && path[0] == collateralToken && path[path.length - 1] == address(usdc), "bad path");

        l.status = Status.Settled;
        uint256 collateralAmount = l.collateralAmount;
        _safeApprove(collateralToken, address(dexRouter), collateralAmount);
        uint256[] memory amounts = dexRouter.swapExactTokensForTokens(collateralAmount, amountOutMinimum, path, address(this), deadline);
        uint256 proceeds = amounts[amounts.length - 1];

        if (proceeds >= l.usdcDue) {
            _safeTransfer(address(usdc), l.lender, l.usdcDue);
            uint256 excess = proceeds - l.usdcDue;
            if (excess > 0) _safeTransfer(address(usdc), house, excess);
        } else {
            _safeTransfer(address(usdc), l.lender, proceeds);
            uint256 shortfall = l.usdcDue - proceeds;
            deficits[loanId] = shortfall;
            emit DeficitRecorded(loanId, shortfall);
        }
        emit Settled(loanId, proceeds);
    }

    /// House-only, manually triggered: the human-in-the-loop control for a recorded default
    /// shortfall. Caller must have approved this contract for the deficit amount of USDC.
    function payDeficit(bytes32 loanId) external nonReentrant {
        Loan storage l = loans[loanId];
        require(msg.sender == house, "only house");
        uint256 amount = deficits[loanId];
        require(amount > 0, "no deficit");
        deficits[loanId] = 0;
        _safeTransferFrom(address(usdc), msg.sender, l.lender, amount);
        emit DeficitPaid(loanId, amount);
    }

    /// Disclosed fallback (see contract-level note above): returns collateral to the borrower
    /// if nobody has settled by cancelAfter. Permissionless, like settle().
    function cancel(bytes32 loanId) external nonReentrant {
        Loan storage l = loans[loanId];
        require(l.status == Status.Locked, "not locked");
        require(block.timestamp >= l.cancelAfter, "too early");
        l.status = Status.Cancelled;
        _safeTransfer(collateralToken, l.borrower, l.collateralAmount);
        emit Cancelled(loanId);
    }

    /// Minimal ECDSA recovery with the usual malleability guards (low-s, v in {27, 28}).
    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        require(signature.length == 65, "bad signature length");
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad signature v");
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "bad signature s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad signature");
        return signer;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "approve failed");
    }
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// Minimal Uniswap-V2-router-shaped interface. Arc's real DEX router shape is unverified from
/// here (see src/params.js DEX_ROUTER_ADDRESS) -- this is the most common shape and is the
/// placeholder assumption; confirm and adjust before mainnet if Arc's router differs.
interface IDexRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

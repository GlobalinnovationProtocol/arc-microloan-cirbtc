// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal non-custodial collateral escrow for one fixed-term micro-loan product.
/// USDC is the loan currency; the collateral token is a per-loan parameter. In this deployment the
/// house allows exactly one collateral, cirBTC (Circle's natively issued bitcoin token on Arc, an
/// ERC-20 since Arc's gas is USDC); the parameter stays generic so the audited bytecode is unchanged.
///
/// Design choices, deliberately minimizing attack surface:
/// - No admin key, no owner, no pausability, no upgradeability: a bug needs a new deployment,
///   not a patch -- a disclosed tradeoff in exchange for nothing here ever being able to
///   rug/freeze/redirect funds after audit.
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
///   borrower who defaulted, not to the house. Because settle() is permissionless (not gated
///   behind one operator's automation), this is far less likely to be hit in practice than in
///   the XRPL design, but the limitation itself is unchanged and must stay disclosed.
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
        address house;
        address collateralToken;
        uint256 collateralAmount;
        uint256 usdcDue; // principal + interest, fixed at lock time
        bytes32 conditionHash; // keccak256(preimage); mirrors the XRPL build's PREIMAGE-SHA-256 condition
        uint64 finishAfter; // loan maturity (unix seconds)
        uint64 cancelAfter; // grace-window fallback (unix seconds)
        Status status;
    }

    IERC20 public immutable usdc;
    IDexRouter public immutable dexRouter;

    mapping(bytes32 => Loan) public loans;
    mapping(bytes32 => uint256) public deficits;

    bool private _entered;

    event Locked(bytes32 indexed loanId, address indexed borrower, address indexed lender, address collateralToken, uint256 collateralAmount);
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

    constructor(address usdcAddress, address dexRouterAddress) {
        require(usdcAddress != address(0) && dexRouterAddress != address(0), "zero address");
        usdc = IERC20(usdcAddress);
        dexRouter = IDexRouter(dexRouterAddress);
    }

    /// Borrower locks collateral for one loan. Caller must have approved this contract for at
    /// least collateralAmount of collateralToken beforehand. loanId is chosen off-chain (the
    /// server's loan session id) and must be unused.
    function lock(
        bytes32 loanId,
        address collateralToken,
        uint256 collateralAmount,
        address lender,
        address house,
        uint256 usdcDue,
        bytes32 conditionHash,
        uint64 finishAfter,
        uint64 cancelAfter
    ) external nonReentrant {
        require(loans[loanId].status == Status.None, "loan exists");
        require(collateralToken != address(0) && lender != address(0) && house != address(0), "zero address");
        require(collateralAmount > 0 && usdcDue > 0, "zero amount");
        require(finishAfter > block.timestamp, "finishAfter in the past");
        require(cancelAfter > finishAfter, "cancelAfter must follow finishAfter");

        loans[loanId] = Loan({
            borrower: msg.sender,
            lender: lender,
            house: house,
            collateralToken: collateralToken,
            collateralAmount: collateralAmount,
            usdcDue: usdcDue,
            conditionHash: conditionHash,
            finishAfter: finishAfter,
            cancelAfter: cancelAfter,
            status: Status.Locked
        });

        _safeTransferFrom(collateralToken, msg.sender, address(this), collateralAmount);
        emit Locked(loanId, msg.sender, lender, collateralToken, collateralAmount);
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
        _safeTransfer(l.collateralToken, l.borrower, l.collateralAmount);
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
        require(path.length >= 2 && path[0] == l.collateralToken && path[path.length - 1] == address(usdc), "bad path");

        l.status = Status.Settled;
        uint256 collateralAmount = l.collateralAmount;
        _safeApprove(l.collateralToken, address(dexRouter), collateralAmount);
        uint256[] memory amounts = dexRouter.swapExactTokensForTokens(collateralAmount, amountOutMinimum, path, address(this), deadline);
        uint256 proceeds = amounts[amounts.length - 1];

        if (proceeds >= l.usdcDue) {
            _safeTransfer(address(usdc), l.lender, l.usdcDue);
            uint256 excess = proceeds - l.usdcDue;
            if (excess > 0) _safeTransfer(address(usdc), l.house, excess);
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
        require(msg.sender == l.house, "only house");
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
        _safeTransfer(l.collateralToken, l.borrower, l.collateralAmount);
        emit Cancelled(loanId);
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

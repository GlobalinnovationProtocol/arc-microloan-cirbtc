// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMockERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Test-only stand-in for the real Arc DEX router (shape unverified -- see
/// contracts/LoanEscrow.sol IDexRouter and src/params.js DEX_ROUTER_ADDRESS). Swaps at a fixed,
/// test-configured rate so LoanEscrow.test.js can deterministically exercise the excess and
/// deficit settlement branches.
contract MockDexRouter {
    // rate is expressed as "amountOut per 1e18 amountIn", so a rate of 2e18 means 1 unit of
    // collateral sells for 2 units of output token (matching the quote-time collateral price).
    uint256 public rate = 1e18;

    function setRate(uint256 newRate) external {
        rate = newRate;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        uint256 amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= amountOutMin, "insufficient output amount");
        require(IMockERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        require(IMockERC20(path[path.length - 1]).transfer(to, amountOut), "payout failed");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = amountOut;
    }
}

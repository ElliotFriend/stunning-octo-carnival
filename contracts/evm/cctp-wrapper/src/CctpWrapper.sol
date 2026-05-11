// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

/// EVM analog of the Soroban `CctpWrapperContract.approve_and_deposit`.
/// One user signature (EIP-712 permit) + one transaction bundles
/// `usdc.permit` + `usdc.transferFrom` + `usdc.approve` + `depositForBurnWithHook`.
///
/// The wrapper holds USDC only transiently within a single call: it pulls the
/// exact `amount` from the user via `transferFrom`, hands the same `amount` to
/// the TokenMessenger via `approve`, and the burn drains the balance back to 0.
contract CctpWrapper {
    IERC20Permit public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;

    constructor(address _usdc, address _tokenMessenger) {
        usdc = IERC20Permit(_usdc);
        tokenMessenger = ITokenMessengerV2(_tokenMessenger);
    }

    function bridgeWithPermit(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData,
        uint256 permitDeadline,
        uint8 permitV,
        bytes32 permitR,
        bytes32 permitS
    ) external {
        usdc.permit(msg.sender, address(this), amount, permitDeadline, permitV, permitR, permitS);
        IERC20(address(usdc)).transferFrom(msg.sender, address(this), amount);
        IERC20(address(usdc)).approve(address(tokenMessenger), amount);
        tokenMessenger.depositForBurnWithHook(
            amount,
            destinationDomain,
            mintRecipient,
            address(usdc),
            destinationCaller,
            maxFee,
            minFinalityThreshold,
            hookData
        );
    }
}

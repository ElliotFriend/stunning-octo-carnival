// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CctpWrapper} from "../src/CctpWrapper.sol";

/// Deploy via:
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --private-key $PK
///   forge script script/Deploy.s.sol --rpc-url arc_testnet  --broadcast --private-key $PK
///
/// TokenMessengerV2 is the same deterministic address on every CCTP V2 testnet.
/// USDC differs per chain.
contract Deploy is Script {
    address constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    function run() external {
        address usdc = _usdcForChain(block.chainid);
        vm.startBroadcast();
        CctpWrapper wrapper = new CctpWrapper(usdc, TOKEN_MESSENGER_V2);
        vm.stopBroadcast();
        console.log("CctpWrapper deployed:", address(wrapper));
        console.log("  usdc:", usdc);
        console.log("  tokenMessenger:", TOKEN_MESSENGER_V2);
    }

    function _usdcForChain(uint256 chainId) internal pure returns (address) {
        if (chainId == 84532) return 0x036CbD53842c5426634e7929541eC2318f3dCF7e; // Base Sepolia
        if (chainId == 5042002) return 0x3600000000000000000000000000000000000000; // Arc testnet
        revert("Unsupported chain");
    }
}

import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";

// Deployer key comes from the environment only (never committed): DEPLOYER_PRIVATE_KEY=0x...
const deployer = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/contract",
  },
  networks: {
    hardhat: {},
    // Arc gas is USDC (18-decimal native representation); the mempool enforces a 20 gwei maxFeePerGas floor.
    arcTestnet: {
      url: process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts: deployer,
    },
    arcMainnet: {
      url: process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io",
      chainId: 5042,
      accounts: deployer,
    },
  },
};

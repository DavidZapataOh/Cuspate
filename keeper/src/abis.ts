import { parseAbi } from "viem";

/** The contracts the keeper calls, as far as it calls them. */
export const ERC20 = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function balanceOf(address holder) view returns (uint256)",
	"function totalSupply() view returns (uint256)",
]);

export const VAULT = parseAbi([
	"function CAP() view returns (uint256)",
	"function YES() view returns (address)",
	"function NO() view returns (address)",
	"function COLLATERAL() view returns (address)",
	"function splitPosition(uint256 amount)",
	"function mergePositions(uint256 amount)",
]);

export const FACTORY = parseAbi([
	"function markets(bytes32 marketId) view returns (address underlyingVault, address dollarVault)",
]);

export const HOOK = parseAbi([
	"function freezesAt(bytes32 poolId) view returns (uint64)",
]);

const POOL_KEY =
	"(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";

export const ROUTER = parseAbi([
	"function enter(bytes32 marketId, bool yes, uint256 dollars, uint256 minShares, address recipient, uint256 deadline) returns (uint256)",
	"function exit((bytes32 marketId, bool yes, uint256 shares, uint256 kept, uint256 minOut, bool levelSellsWorldDollar, uint256 level, uint256 minLevelOut, address recipient, uint256 deadline) order) returns (uint256)",
]);

export const STATE_VIEW = parseAbi([
	"function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

export const ORACLE = parseAbi([
	"function latestPrice(bytes32 priceId) view returns (int128 price, int128 bestBid, int128 bestAsk, uint64 feedUpdateTimestamp, uint64 publishedAt, uint80 roundId, uint8 session)",
]);

export const QUOTER = parseAbi([
	`function quoteExactInputSingle((${POOL_KEY} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
	`function quoteExactOutputSingle((${POOL_KEY} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountIn, uint256 gasEstimate)`,
]);

export const PERMIT2 = parseAbi([
	"function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

export const UNIVERSAL_ROUTER = parseAbi([
	"function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

export const SAFE = parseAbi([
	"function nonce() view returns (uint256)",
	"function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
	"function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
	"function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
	"event ExecutionSuccess(bytes32 txHash, uint256 payment)",
	"event ExecutionFailure(bytes32 txHash, uint256 payment)",
]);

export const SAFE_FACTORY = parseAbi([
	"function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
	"event ProxyCreation(address indexed proxy, address singleton)",
]);

export const MULTI_SEND = parseAbi([
	"function multiSend(bytes transactions) payable",
]);

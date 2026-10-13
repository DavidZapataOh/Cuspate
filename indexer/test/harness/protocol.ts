/**
 * The protocol deployed on a fork, and one market taken through its whole life: sealed, created,
 * split, its three pools opened and traded through the router, merged, frozen early, proposed,
 * disputed, proposed again, settled, its first contest ruled, redeemed, and a bond withdrawn.
 */
import {
	type Abi,
	type Address,
	type Hex,
	maxUint256,
	parseAbi,
	parseEventLogs,
	zeroHash,
} from "viem";
import { artifact, deploy, deployHook, type Fork, thirdParty } from "./fork";

/** The roles a market's life involves, each its own address. */
export const ROLES = {
	sealer: "0x00000000000000000000000000000000000a11e1",
	arbiter: "0x00000000000000000000000000000000000a11e2",
	guardian: "0x00000000000000000000000000000000000a11e3",
	holder: "0x00000000000000000000000000000000000a11e4",
	proposer: "0x00000000000000000000000000000000000a11e5",
	disputer: "0x00000000000000000000000000000000000a11e6",
	reproposer: "0x00000000000000000000000000000000000a11e7",
} as const satisfies Record<string, Address>;

const BOND = 1_000_000n;
const LIVENESS = 3600n;
const DAY = 86_400n;
const ERC20 = parseAbi([
	"function approve(address, uint256) returns (bool)",
	"function balanceOf(address) view returns (uint256)",
]);

/** The deployed protocol's contracts, and the block the first was deployed in. */
export type Protocol = Awaited<ReturnType<typeof deployProtocol>>;

/** Deploys the protocol's contracts, in the order the contracts' own fork tests deploy them. */
export async function deployProtocol(fork: Fork) {
	const dollar = thirdParty("dollar");
	const factory = await deploy(fork, "MarketFactory");
	const registry = await deploy(fork, "ThresholdRegistry");
	const resolver = await deploy(fork, "OptimisticResolver", [
		factory.address,
		registry.address,
		ROLES.sealer,
		ROLES.arbiter,
		dollar,
		BOND,
		BOND / 5n,
		LIVENESS,
		7n * DAY,
		7n * DAY,
	]);
	const hook = await deployHook(fork, [
		thirdParty("poolManager"),
		resolver.address,
		ROLES.guardian,
	]);
	const router = await deploy(fork, "PositionRouter", [hook.address]);
	return {
		firstBlock: factory.block,
		factory,
		registry,
		resolver,
		hook,
		router,
	};
}

async function send(
	fork: Fork,
	from: Address,
	to: Address,
	abi: Abi,
	functionName: string,
	args: readonly unknown[],
) {
	const wallet = await fork.as(from);
	const hash = await wallet.writeContract({
		address: to,
		abi,
		functionName,
		args,
		chain: null,
	});
	const receipt = await fork.client.waitForTransactionReceipt({ hash });
	if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
	return receipt;
}

function read<T>(
	fork: Fork,
	address: Address,
	abi: Abi,
	functionName: string,
	args: readonly unknown[] = [],
) {
	return fork.client.readContract({
		address,
		abi,
		functionName,
		args,
	}) as Promise<T>;
}

/** A pool's key, as the protocol derives it: the pair in address order, its fee and spacing, the hook. */
function poolKey(a: Address, b: Address, hook: Address) {
	const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
	return { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: hook };
}

/** Takes one market through its whole life, and says what it created. */
export async function liveOneMarket(fork: Fork, protocol: Protocol) {
	const underlying = thirdParty("collateral");
	const dollar = thirdParty("dollar");
	const manager = thirdParty("poolManager");
	const { factory, registry, resolver, hook, router } = protocol;
	const { holder } = ROLES;
	const now = (await fork.client.getBlock()).timestamp;
	const announcesAt = now + DAY;

	const sealed = await send(
		fork,
		ROLES.sealer,
		registry.address,
		registry.abi,
		"seal",
		[
			{
				value: 3000n,
				decimals: 2,
				announcesAt,
				deadline: announcesAt + DAY,
				terms: `0x${Buffer.from("a figure").toString("hex")}`,
			},
		],
	);
	const [{ args: seal }] = parseEventLogs({
		abi: registry.abi,
		logs: sealed.logs,
		eventName: "ThresholdSealed",
	}) as unknown as [{ args: { eventId: Hex } }];
	const eventId = seal.eventId;

	const created = await send(
		fork,
		holder,
		factory.address,
		factory.abi,
		"createMarket",
		[
			underlying,
			dollar,
			eventId,
			resolver.address,
			100n * 10n ** 18n,
			10n ** 12n,
		],
	);
	const [{ args: market }] = parseEventLogs({
		abi: factory.abi,
		logs: created.logs,
		eventName: "MarketCreated",
	}) as unknown as [
		{ args: { marketId: Hex; underlyingVault: Address; dollarVault: Address } },
	];
	const { marketId, underlyingVault, dollarVault } = market;
	await send(fork, holder, hook.address, hook.abi, "register", [
		marketId,
		eventId,
	]);

	// Split both collaterals.
	const vault = artifact("PositionVault").abi;
	await fork.deal(underlying, holder, 10n * 10n ** 18n);
	await fork.deal(dollar, holder, 100_000n * 10n ** 6n);
	await send(fork, holder, underlying, ERC20, "approve", [
		underlyingVault,
		maxUint256,
	]);
	await send(fork, holder, dollar, ERC20, "approve", [dollarVault, maxUint256]);
	await send(fork, holder, underlyingVault, vault, "splitPosition", [
		10n * 10n ** 18n,
	]);
	await send(fork, holder, dollarVault, vault, "splitPosition", [
		50_000n * 10n ** 6n,
	]);
	const legs = {
		underlyingYes: await read<Address>(fork, underlyingVault, vault, "YES"),
		underlyingNo: await read<Address>(fork, underlyingVault, vault, "NO"),
		dollarYes: await read<Address>(fork, dollarVault, vault, "YES"),
		dollarNo: await read<Address>(fork, dollarVault, vault, "NO"),
	};

	// Open the three pools at one raw unit for one and seed them around it.
	const seeder = await deploy(fork, "PoolModifyLiquidityTest", [manager]);
	for (const leg of Object.values(legs))
		await send(fork, holder, leg, ERC20, "approve", [
			seeder.address,
			maxUint256,
		]);
	const managerAbi = artifact("IPoolManager").abi;
	const keys = [
		poolKey(legs.underlyingYes, legs.dollarYes, hook.address),
		poolKey(legs.underlyingNo, legs.dollarNo, hook.address),
		poolKey(legs.dollarYes, legs.dollarNo, hook.address),
	];
	for (const key of keys) {
		await send(fork, holder, manager, managerAbi, "initialize", [
			key,
			2n ** 96n,
		]);
		await send(fork, holder, seeder.address, seeder.abi, "modifyLiquidity", [
			key,
			{
				tickLower: -1860,
				tickUpper: 1860,
				liquidityDelta: 10n ** 11n,
				salt: zeroHash,
			},
			"0x",
		]);
	}

	// Trade through the router: enter one world with dollars, then sell part of the shares back.
	const deadline = now + DAY;
	await send(fork, holder, dollar, ERC20, "approve", [
		router.address,
		maxUint256,
	]);
	await send(fork, holder, router.address, router.abi, "enter", [
		marketId,
		true,
		100n * 10n ** 6n,
		1n,
		holder,
		deadline,
	]);
	const shares = await read<bigint>(
		fork,
		legs.underlyingYes,
		ERC20,
		"balanceOf",
		[holder],
	);
	await send(fork, holder, legs.underlyingYes, ERC20, "approve", [
		router.address,
		maxUint256,
	]);
	await send(fork, holder, router.address, router.abi, "exit", [
		{
			marketId,
			yes: true,
			shares: 10n ** 9n,
			kept: 0n,
			minOut: 1n,
			levelSellsWorldDollar: false,
			level: 0n,
			minLevelOut: 0n,
			recipient: holder,
			deadline,
		},
	]);

	// A position wholly above the price after the last trade: it holds liquidity the pool does not
	// count as active until the price enters its range.
	await send(fork, holder, seeder.address, seeder.abi, "modifyLiquidity", [
		keys[0],
		{
			tickLower: 6000,
			tickUpper: 7200,
			liquidityDelta: 10n ** 10n,
			salt: zeroHash,
		},
		"0x",
	]);

	// Merge some of the dollar legs back, then the guardian freezes the market early.
	await send(fork, holder, dollarVault, vault, "mergePositions", [
		1_000n * 10n ** 6n,
	]);
	await send(fork, ROLES.guardian, hook.address, hook.abi, "freezeNow", [
		marketId,
	]);

	// Resolution: a proposal, disputed; a second, settled; the first contest ruled.
	await fork.warp(DAY);
	for (const who of [ROLES.proposer, ROLES.disputer, ROLES.reproposer]) {
		await fork.deal(dollar, who, 10n * BOND);
		await send(fork, who, dollar, ERC20, "approve", [
			resolver.address,
			maxUint256,
		]);
	}
	await send(
		fork,
		ROLES.proposer,
		resolver.address,
		resolver.abi,
		"proposeFigure",
		[eventId, 2900n, 2],
	);
	await send(fork, ROLES.disputer, resolver.address, resolver.abi, "dispute", [
		eventId,
		0,
	]);
	await send(
		fork,
		ROLES.reproposer,
		resolver.address,
		resolver.abi,
		"proposeFigure",
		[eventId, 3342n, 2],
	);
	await fork.warp(LIVENESS);
	await send(fork, holder, resolver.address, resolver.abi, "settle", [eventId]);
	await send(
		fork,
		ROLES.arbiter,
		resolver.address,
		resolver.abi,
		"ruleContest",
		[eventId, false, "the first figure was wrong"],
	);

	// Redeem what the holder still has, and the winning disputer withdraws.
	for (const [address, yes, no] of [
		[underlyingVault, legs.underlyingYes, legs.underlyingNo],
		[dollarVault, legs.dollarYes, legs.dollarNo],
	] as const) {
		const yesAmount = await read<bigint>(fork, yes, ERC20, "balanceOf", [
			holder,
		]);
		const noAmount = await read<bigint>(fork, no, ERC20, "balanceOf", [holder]);
		await send(fork, holder, address, vault, "redeemPositions", [
			yesAmount,
			noAmount,
		]);
	}
	await send(
		fork,
		ROLES.disputer,
		resolver.address,
		resolver.abi,
		"withdraw",
		[],
	);

	return {
		eventId,
		marketId,
		underlyingVault,
		dollarVault,
		legs,
		shares,
		lastBlock: await fork.client.getBlockNumber(),
	};
}

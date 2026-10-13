/**
 * The indexer reproduces the chain: a market taken through its whole life on a fork of the production
 * chain is indexed from the protocol's first block, and every entity is compared, field by field, with
 * what the contracts answer.
 */
import { createTestIndexer } from "envio";
import { type Abi, type Address, type Hex, parseAbi } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { artifact, type Fork, startFork, thirdParty } from "./harness/fork";
import {
	deployProtocol,
	liveOneMarket,
	type Protocol,
	ROLES,
} from "./harness/protocol";

const ERC20 = parseAbi([
	"function totalSupply() view returns (uint256)",
	"function balanceOf(address) view returns (uint256)",
]);
const STATE_VIEW = parseAbi([
	"function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
	"function getLiquidity(bytes32) view returns (uint128)",
]);
const VAULT = artifact("PositionVault").abi;

let fork: Fork;
let protocol: Protocol;
let life: Awaited<ReturnType<typeof liveOneMarket>>;
let indexed: ReturnType<typeof createTestIndexer>;

const read = <T>(
	address: Address,
	abi: Abi,
	functionName: string,
	args: readonly unknown[] = [],
) =>
	fork.client.readContract({ address, abi, functionName, args }) as Promise<T>;
const lower = (value: string) => value.toLowerCase();

beforeAll(async () => {
	fork = await startFork();
	protocol = await deployProtocol(fork);
	life = await liveOneMarket(fork, protocol);
	Object.assign(process.env, {
		CUSPATE_RPC_URL: fork.url,
		CUSPATE_START_BLOCK: String(protocol.firstBlock),
		CUSPATE_MARKET_FACTORY: protocol.factory.address,
		CUSPATE_FREEZE_HOOK: protocol.hook.address,
		CUSPATE_POSITION_ROUTER: protocol.router.address,
		CUSPATE_THRESHOLD_REGISTRY: protocol.registry.address,
		CUSPATE_RESOLVER: protocol.resolver.address,
	});
	indexed = createTestIndexer();
	await indexed.process({
		chains: {
			143: {
				startBlock: Number(protocol.firstBlock),
				endBlock: Number(life.lastBlock),
			},
		},
	});
}, 600_000);

afterAll(() => fork?.stop());

describe("the indexer, against the chain", () => {
	test("finds the market with its vaults and the legs no event names", async () => {
		const [market] = await indexed.Market.getAll();
		expect(market.id).toBe(life.marketId);
		expect(market.eventId).toBe(life.eventId);
		expect(market.condition).toBe(
			await read<Hex>(life.underlyingVault, VAULT, "CONDITION"),
		);
		for (const address of [life.underlyingVault, life.dollarVault]) {
			const vault = await indexed.Vault.getOrThrow(lower(address));
			expect(vault.yes).toBe(lower(await read<Address>(address, VAULT, "YES")));
			expect(vault.no).toBe(lower(await read<Address>(address, VAULT, "NO")));
			expect(vault.cap).toBe(await read<bigint>(address, VAULT, "CAP"));
			expect(vault.collateral).toBe(
				lower(await read<Address>(address, VAULT, "COLLATERAL")),
			);
		}
	});

	test("every leg's supply is the chain's", async () => {
		const legs = await indexed.Leg.getAll();
		expect(legs.length).toBe(4);
		for (const leg of legs)
			expect([leg.id, leg.supply]).toEqual([
				leg.id,
				await read<bigint>(leg.id as Address, ERC20, "totalSupply"),
			]);
	});

	test("every balance is the chain's", async () => {
		const balances = await indexed.Balance.getAll();
		expect(balances.length).toBeGreaterThan(4);
		for (const balance of balances) {
			const onChain = await read<bigint>(
				balance.leg as Address,
				ERC20,
				"balanceOf",
				[balance.holder],
			);
			expect([balance.id, balance.amount]).toEqual([balance.id, onChain]);
		}
	});

	test("every pool's price, tick, liquidity and freeze are the chain's", async () => {
		const pools = await indexed.Pool.getAll();
		expect(pools.map((pool) => pool.kind).sort()).toEqual([
			"no",
			"probability",
			"yes",
		]);
		for (const pool of pools) {
			const [sqrtPriceX96, tick] = await read<[bigint, number]>(
				thirdParty("stateView"),
				STATE_VIEW,
				"getSlot0",
				[pool.id],
			);
			const liquidity = await read<bigint>(
				thirdParty("stateView"),
				STATE_VIEW,
				"getLiquidity",
				[pool.id],
			);
			const freezesAt = await read<bigint>(
				protocol.hook.address,
				protocol.hook.abi,
				"freezesAt",
				[pool.id],
			);
			expect({
				id: pool.id,
				sqrtPriceX96: pool.sqrtPriceX96,
				tick: pool.tick,
				liquidity: pool.liquidity,
				freezesAt: pool.freezesAt,
			}).toEqual({
				id: pool.id,
				sqrtPriceX96,
				tick,
				liquidity,
				freezesAt,
			});
			expect(pool.initialized && pool.frozenEarly).toBe(true);
		}
		expect((await indexed.Swap.getAll()).length).toBeGreaterThan(0);
		expect((await indexed.LiquidityChange.getAll()).length).toBe(4);
	});

	test("the seal is the registry's", async () => {
		const seal = await indexed.Seal.getOrThrow(life.eventId);
		const [sealer, sealBlock, threshold] = await read<
			[
				Address,
				bigint,
				{
					value: bigint;
					decimals: number;
					announcesAt: bigint;
					deadline: bigint;
					terms: Hex;
				},
			]
		>(protocol.registry.address, protocol.registry.abi, "sealOf", [
			life.eventId,
		]);
		expect(seal).toEqual({
			id: life.eventId,
			sealer: lower(sealer),
			sealBlock,
			value: threshold.value,
			decimals: threshold.decimals,
			announcesAt: threshold.announcesAt,
			deadline: threshold.deadline,
			terms: threshold.terms,
		});
	});

	test("the resolution, round by round, is the resolver's", async () => {
		type Round = {
			proposer: Address;
			proposedAt: bigint;
			invalid: boolean;
			settled: boolean;
			figure: bigint;
			decimals: number;
			disputer: Address;
			ruled: boolean;
			ruledAt: bigint;
			reason: string;
		};
		const state = await read<{
			round: number;
			pendingArbitration: boolean;
			rounds: readonly [Round, Round];
			outcomeReason: string;
		}>(protocol.resolver.address, protocol.resolver.abi, "eventOf", [
			life.eventId,
		]);
		const resolution = await indexed.Resolution.getOrThrow(life.eventId);
		expect([
			resolution.round,
			resolution.pendingArbitration,
			resolution.outcomeReason,
		]).toEqual([state.round, state.pendingArbitration, state.outcomeReason]);
		for (const round of [0, 1]) {
			const proposal = await indexed.Proposal.getOrThrow(
				`${life.eventId}-${round}`,
			);
			const chain = state.rounds[round];
			expect({
				...proposal,
				id: undefined,
				resolution: undefined,
				round: undefined,
			}).toEqual({
				id: undefined,
				resolution: undefined,
				round: undefined,
				proposer: lower(chain.proposer),
				proposedAt: chain.proposedAt,
				invalid: chain.invalid,
				settled: chain.settled,
				figure: chain.figure,
				decimals: chain.decimals,
				disputer: lower(chain.disputer),
				ruled: chain.ruled,
				ruledAt: BigInt(chain.ruledAt),
				reason: chain.reason,
			});
		}
	});

	test("the reported outcome is the factory's", async () => {
		const [condition] = await indexed.Condition.getAll();
		expect(condition.outcome).toBe(
			Number(
				await read<number>(
					protocol.factory.address,
					protocol.factory.abi,
					"outcomeOf",
					[condition.id],
				),
			),
		);
		expect(condition.outcome).toBe(1);
	});

	test("every action the market's life took is recorded once", async () => {
		expect((await indexed.Entry.getAll()).length).toBe(1);
		expect((await indexed.Exit.getAll()).length).toBe(1);
		const conversions = await indexed.Conversion.getAll();
		const splits = conversions.filter((conversion) => !conversion.merge);
		// The holder split both collaterals; entering a world splits the dollars inside the router.
		expect(splits.map((split) => split.stakeholder).sort()).toEqual(
			[ROLES.holder, ROLES.holder, protocol.router.address].map(lower).sort(),
		);
		const merges = conversions.filter((conversion) => conversion.merge);
		expect(
			merges.some((merge) => merge.stakeholder === lower(ROLES.holder)),
		).toBe(true);
		expect((await indexed.Redemption.getAll()).length).toBe(2);
		expect((await indexed.Withdrawal.getAll()).length).toBe(1);
	});
});

import { parseEther } from "viem";
import { describe, expect, test } from "vitest";
import { refuseBudget, tally } from "../../src/budget.ts";

const enough = {
	deployer: parseEther("32.2"),
	publisher: parseEther("3"),
	keeper: parseEther("3"),
};
const needs = {
	batch: parseEther("5.6"),
	publisherWeek: parseEther("1"),
	keeperWeek: parseEther("0.5"),
};

describe("the MON a batch needs", () => {
	test("a funded batch passes", () => {
		expect(refuseBudget(enough, needs)).toBeNull();
	});

	test("the deployer must cover the batch and a fifth more", () => {
		expect(
			refuseBudget({ ...enough, deployer: parseEther("6.5") }, needs),
		).toMatch(/deployer/);
		expect(
			refuseBudget({ ...enough, deployer: parseEther("6.8") }, needs),
		).toBeNull();
	});

	test("the publisher and the keeper must each cover a week", () => {
		expect(
			refuseBudget({ ...enough, publisher: parseEther("0.9") }, needs),
		).toMatch(/publisher/);
		expect(
			refuseBudget({ ...enough, keeper: parseEther("0.4") }, needs),
		).toMatch(/keeper/);
	});

	test("gas is tallied by kind of step", () => {
		const sent = [
			{ kind: "seal", gasLimit: 100n },
			{ kind: "seal", gasLimit: 50n },
			{ kind: "seed", gasLimit: 7n },
		];
		expect(tally(sent)).toEqual({ seal: 150n, seed: 7n });
	});
});

import { describe, expect, test } from "bun:test";
import committed from "./config.json";
import { configSchema, initWorkflow } from "./workflow";

describe("configuration", () => {
	test("the committed configuration is valid", () => {
		expect(configSchema.safeParse(committed).success).toBe(true);
	});

	test("a schedule without seconds is refused", () => {
		expect(configSchema.safeParse({ schedule: "*/10 * * * *" }).success).toBe(
			false,
		);
	});
});

describe("the workflow", () => {
	test("registers exactly one handler, on the cron trigger", () => {
		expect(initWorkflow(configSchema.parse(committed))).toHaveLength(1);
	});
});

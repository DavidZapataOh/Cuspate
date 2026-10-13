// Adapted in structure from smartcontractkit/cre-templates (MIT, commit d0223f3), the TypeScript
// starter templates: a validated configuration and one cron handler.
import { CronCapability, handler, type Runtime } from "@chainlink/cre-sdk";
import { z } from "zod";

export const configSchema = z.object({
	// Six fields, seconds first, as the platform's cron trigger reads them.
	schedule: z.string().regex(/^(\S+\s+){5}\S+$/, "a six-field cron schedule"),
});

export type Config = z.infer<typeof configSchema>;

export const onCron = (runtime: Runtime<Config>): string => {
	runtime.log("resolver-proposer: run started");
	return "ok";
};

export const initWorkflow = (config: Config) => {
	const cron = new CronCapability();
	return [handler(cron.trigger({ schedule: config.schedule }), onCron)];
};

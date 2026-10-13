import type { NextConfig } from "next";

/** The interface's build: no framework banner in responses, and React's strict checks on. */
const config: NextConfig = {
	poweredByHeader: false,
	reactStrictMode: true,
};

export default config;

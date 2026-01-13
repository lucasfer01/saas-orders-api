import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const app = buildApp();

async function main() {
	try {
		await app.listen({ port: env.PORT, host: "0.0.0.0" });
		app.log.info({ port: env.PORT }, "API listening");
	} catch (err) {
		app.log.error({ err }, "Failed to start server");
		process.exit(1);
	}
}

const shutdown = async (signal: string) => {
	app.log.info({ signal }, "Shutting down...");
	try {
		await app.close();
		process.exit(0);
	} catch (err) {
		app.log.error({ err }, "Shutdown error");
		process.exit(1);
	}
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void main();

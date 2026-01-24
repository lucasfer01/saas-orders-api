import { join } from "node:path";
import { config } from "dotenv";

// Load test env
config({ path: join(process.cwd(), ".env.test") });

process.env.NODE_ENV = process.env.NODE_ENV || "test";

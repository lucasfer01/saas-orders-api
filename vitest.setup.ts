import { config } from "dotenv";
import { join } from "node:path";

// Load test env
config({ path: join(process.cwd(), ".env.test") });

process.env.NODE_ENV = process.env.NODE_ENV || "test";

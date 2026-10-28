import { readFileSync } from "fs";
import path from "path";
import { loadDotEnv } from "../../src/load-env";

const backendRoot = path.resolve(__dirname, "../..");
const secret = readFileSync(path.resolve(backendRoot, "../.pg-secret"), "utf8").trim();
process.env.DATABASE_URL = `postgresql://datcamis_app:${encodeURIComponent(secret)}@127.0.0.1:5434/datcamis?schema=public`;
loadDotEnv(path.join(backendRoot, ".env"));

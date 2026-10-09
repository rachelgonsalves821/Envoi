import { fileURLToPath } from "node:url";

/** All client runners resolve the same setup and Lane A-owned registry. */
export const sharedFixtureSetup = fileURLToPath(new URL("./setup.ts", import.meta.url));

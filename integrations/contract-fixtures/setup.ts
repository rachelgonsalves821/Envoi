import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PublishedContract {
  id: string;
  version: number;
  status: "published" | "approved";
  handoff: string;
  dir: string;
  schemas?: string;
  fixtures: string[];
}
export interface ContractRegistry { version: number; contracts: PublishedContract[] }

/** Read the canonical source directly, independent of a runner’s working directory. */
export const contractRegistryPath = fileURLToPath(new URL("../../test/contract-fixtures/index.json", import.meta.url));
export const contractRegistry: ContractRegistry = JSON.parse(readFileSync(contractRegistryPath, "utf8"));
if (contractRegistry.version !== 1 || !Array.isArray(contractRegistry.contracts)) {
  throw new Error("Unsupported shared contract fixture registry");
}

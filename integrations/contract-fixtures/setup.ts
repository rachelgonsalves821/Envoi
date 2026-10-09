import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

export function loadContractRegistry(directory = path.dirname(contractRegistryPath)): ContractRegistry {
  const registry: ContractRegistry = JSON.parse(readFileSync(path.join(directory, "index.json"), "utf8"));
  if (registry.version !== 1 || !Array.isArray(registry.contracts)) {
    throw new Error("Unsupported shared contract fixture registry");
  }
  return registry;
}

/** Review can read a publishing worktree before that contract reaches integration. */
export function loadContractFixture(contract: PublishedContract, filename: string, directory = path.dirname(contractRegistryPath)): unknown {
  if (!contract.fixtures.includes(filename) && contract.schemas !== filename) throw new Error("Unregistered contract fixture");
  const root = path.resolve(directory);
  const target = path.resolve(root, contract.dir, filename);
  if (!target.startsWith(root + path.sep)) throw new Error("Invalid contract fixture path");
  return JSON.parse(readFileSync(target, "utf8"));
}

export const contractRegistry = loadContractRegistry();

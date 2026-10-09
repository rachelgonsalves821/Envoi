import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contractRegistry, contractRegistryPath } from "../../../integrations/contract-fixtures/setup";

describe("shared contract fixture import", () => {
  it("loads registry v1 directly from the canonical Lane A source", () => {
    expect(contractRegistryPath.replaceAll("\\", "/")).toMatch(/\/test\/contract-fixtures\/index\.json$/);
    expect(contractRegistry).toEqual(JSON.parse(readFileSync(contractRegistryPath, "utf8")));
    expect(contractRegistry.version).toBe(1);
    expect(Array.isArray(contractRegistry.contracts)).toBe(true);
  });
});

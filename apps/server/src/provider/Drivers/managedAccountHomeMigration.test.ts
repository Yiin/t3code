import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  classifyAccountEntry,
  planManagedAccountHomeMigration,
} from "./managedAccountHomeMigration.ts";

const instance = (driver: string, config: Record<string, unknown>) => ({
  driver: ProviderDriverKind.make(driver),
  config,
});

it("classifies Claude sessions as shadow-local and transcripts as shared", () => {
  expect(classifyAccountEntry("claudeAgent", "sessions")).toBe("shadow-local");
  expect(classifyAccountEntry("claudeAgent", "projects")).toBe("shared");
  expect(classifyAccountEntry("claudeAgent", ".credentials.json")).toBe("private");
});

it("rewrites managed legacy homes without changing provider instance order", () => {
  const accountsDir = "/tmp/t3/accounts";
  const input = {
    claudeAgent: instance("claudeAgent", { homePath: `${accountsDir}/claudeAgent/claudeAgent` }),
    outside: instance("claudeAgent", { homePath: "/other/home" }),
    default: instance("claudeAgent", { homePath: "" }),
  } as ProviderInstanceConfigMap;
  const result = planManagedAccountHomeMigration(
    input,
    accountsDir,
    (value) => value,
    () => "/home/user/.claude",
  );

  expect(Object.keys(result.providerInstances)).toEqual(["claudeAgent", "outside", "default"]);
  const rewritten = result.providerInstances as Record<string, { config?: unknown }>;
  expect(rewritten.claudeAgent?.config).toEqual({
    shadowHomePath: `${accountsDir}/claudeAgent/claudeAgent`,
  });
  expect(rewritten.outside?.config).toEqual({ homePath: "/other/home" });
  expect(result.moves).toEqual([
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: "claudeAgent",
      accountPath: `${accountsDir}/claudeAgent/claudeAgent`,
      sharedPath: "/home/user/.claude",
    },
  ]);
});

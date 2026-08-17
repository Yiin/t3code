import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  classifyAccountEntry,
  migrateAccountHome,
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

it.layer(NodeServices.layer)("managed account home migration on a real filesystem", (it) => {
  const plan = (accountPath: string, sharedPath: string) => ({
    instanceId: ProviderInstanceId.make("claudeAgent_account_2"),
    driver: "claudeAgent",
    accountPath,
    sharedPath,
  });

  it.effect("merges a transcript tree into the shared home and removes the emptied source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-migration-" });
      const account = path.join(root, "account");
      const shared = path.join(root, "shared");
      yield* fs.makeDirectory(path.join(account, "projects", "slug"), { recursive: true });
      yield* fs.writeFileString(path.join(account, "projects", "slug", "a.jsonl"), "a");
      yield* fs.writeFileString(path.join(account, ".credentials.json"), "secret");
      yield* fs.makeDirectory(path.join(account, "sessions"), { recursive: true });
      yield* fs.makeDirectory(path.join(shared, "projects", "slug"), { recursive: true });
      yield* fs.writeFileString(path.join(shared, "projects", "slug", "b.jsonl"), "b");

      expect(yield* migrateAccountHome(plan(account, shared), fs, path)).toBe(true);

      // The source tree is GONE, not merely emptied: `fs.remove` refuses a
      // directory without `recursive`, which once failed every migration.
      expect(yield* fs.exists(path.join(account, "projects"))).toBe(false);
      expect(yield* fs.readFileString(path.join(shared, "projects", "slug", "a.jsonl"))).toBe("a");
      expect(yield* fs.readFileString(path.join(shared, "projects", "slug", "b.jsonl"))).toBe("b");
      expect(yield* fs.readFileString(path.join(account, ".credentials.json"))).toBe("secret");
      expect(yield* fs.exists(path.join(account, "sessions"))).toBe(true);
      expect(yield* fs.exists(path.join(shared, "sessions"))).toBe(false);
    }),
  );

  it.effect("moves a symlinked entry as a link and never empties its target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-migration-link-" });
      const account = path.join(root, "account");
      const shared = path.join(root, "shared");
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(outside, { recursive: true });
      yield* fs.writeFileString(path.join(outside, "MEMORY.md"), "keep me");
      yield* fs.makeDirectory(path.join(account, "projects", "slug"), { recursive: true });
      yield* fs.symlink(outside, path.join(account, "projects", "slug", "memory"));
      yield* fs.makeDirectory(shared, { recursive: true });

      expect(yield* migrateAccountHome(plan(account, shared), fs, path)).toBe(true);

      // The link's target keeps its file: following the link would have moved
      // data that lives outside the account home entirely.
      expect(yield* fs.readFileString(path.join(outside, "MEMORY.md"))).toBe("keep me");
      expect(yield* fs.readLink(path.join(shared, "projects", "slug", "memory"))).toBe(outside);
    }),
  );
});

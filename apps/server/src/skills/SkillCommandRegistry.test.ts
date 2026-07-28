// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeSkillCommandRegistry, parseSkillCommand } from "./SkillCommandRegistry.ts";

describe("SkillCommandRegistry", () => {
  const roots = new Set<string>();

  afterEach(() => {
    for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
    roots.clear();
  });

  const makeRoot = () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-skills-"));
    roots.add(root);
    return root;
  };

  const writeSkill = (root: string, directory: string, content: string) => {
    const dir = NodePath.join(root, directory);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "SKILL.md"), content);
  };

  effectIt.effect("parses valid name and description frontmatter", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const content = "---\nname: cook-it\ndescription: Cook a task\n---\nDo the work.\n";
      writeSkill(root, "cook", content);
      const registry = yield* makeSkillCommandRegistry();

      expect(yield* registry.find(root, "cook-it")).toEqual({
        name: "cook-it",
        description: "Cook a task",
        content,
      });
    }),
  );

  effectIt.effect("skips missing, malformed, and invalid-name frontmatter", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      writeSkill(root, "missing", "No frontmatter");
      writeSkill(root, "malformed", "---\nname: malformed\nNo closing marker");
      writeSkill(root, "bad-terminator", "---\nname: bad-terminator\n---oops\nBody");
      writeSkill(root, "invalid", "---\nname: Not_Valid\n---\n");
      const registry = yield* makeSkillCommandRegistry();

      expect(yield* registry.find(root, "malformed")).toBeUndefined();
      expect(yield* registry.find(root, "bad-terminator")).toBeUndefined();
    }),
  );

  effectIt.effect("resolves duplicate names deterministically by directory name", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      writeSkill(root, "z-last", "---\nname: duplicate\n---\nlast");
      writeSkill(root, "a-first", "---\nname: duplicate\n---\nfirst");
      const registry = yield* makeSkillCommandRegistry();

      const skill = yield* registry.find(root, "duplicate");
      expect(skill?.content).toContain("first");
    }),
  );

  effectIt.effect("invalidates cached results on add, change, and removal", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      writeSkill(root, "one", "---\nname: one\n---\noriginal");
      const registry = yield* makeSkillCommandRegistry();
      expect((yield* registry.find(root, "one"))?.content).toContain("original");

      writeSkill(root, "two", "---\nname: two\n---\nadded");
      expect(yield* registry.find(root, "two")).toBeDefined();

      writeSkill(root, "one", "---\nname: one\n---\nchanged and longer");
      expect((yield* registry.find(root, "one"))?.content).toContain("changed");

      NodeFS.rmSync(NodePath.join(root, "two"), { recursive: true });
      expect(yield* registry.find(root, "two")).toBeUndefined();
    }),
  );

  effectIt.effect("invalidates a same-size rewrite with a preserved timestamp", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      writeSkill(root, "one", "---\nname: one\n---\noriginal");
      const skillPath = NodePath.join(root, "one", "SKILL.md");
      const originalStat = NodeFS.statSync(skillPath);
      const registry = yield* makeSkillCommandRegistry();
      expect((yield* registry.find(root, "one"))?.content).toContain("original");

      writeSkill(root, "one", "---\nname: one\n---\nmodified");
      NodeFS.utimesSync(skillPath, originalStat.atime, originalStat.mtime);

      expect((yield* registry.find(root, "one"))?.content).toContain("modified");
    }),
  );

  effectIt.effect("returns passthrough misses for missing roots", () =>
    Effect.gen(function* () {
      const root = NodePath.join(makeRoot(), "missing");
      const registry = yield* makeSkillCommandRegistry();
      expect(yield* registry.find(root, "anything")).toBeUndefined();
    }),
  );
});

describe("parseSkillCommand", () => {
  it("accepts only exact leading slash commands", () => {
    expect(parseSkillCommand("/cook-it task")).toEqual({ name: "cook-it", arguments: "task" });
    expect(parseSkillCommand("/cook-it")).toEqual({ name: "cook-it", arguments: "" });
    expect(parseSkillCommand(" /cook-it")).toBeUndefined();
    expect(parseSkillCommand("$cook-it")).toBeUndefined();
    expect(parseSkillCommand("/cook-it-extra")).toEqual({
      name: "cook-it-extra",
      arguments: "",
    });
    expect(parseSkillCommand("/cook-it.foo")).toBeUndefined();
  });
});

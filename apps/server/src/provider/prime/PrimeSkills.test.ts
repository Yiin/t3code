// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readPrimeSkills, resolvePrimeSkillsDirectory } from "./PrimeSkills.ts";

const makeTempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-skills-test-"))),
  (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
);

const writeSkill = (root: string, name: string, content: string) =>
  Effect.promise(async () => {
    const directory = NodePath.join(root, name);
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "SKILL.md"), content, "utf8");
    return directory;
  });

it("resolves the skills directory the way install.sh does", () => {
  assert.strictEqual(
    resolvePrimeSkillsDirectory({ PRIME_SKILLS_DIR: "/opt/prime-skills", HOME: "/home/user" }),
    "/opt/prime-skills",
  );
  assert.strictEqual(
    resolvePrimeSkillsDirectory({ PRIME_HOME: "/opt/prime", HOME: "/home/user" }),
    "/opt/prime/skills",
  );
  assert.strictEqual(
    resolvePrimeSkillsDirectory({ HOME: "/home/user" }),
    "/home/user/.prime/skills",
  );
  assert.strictEqual(resolvePrimeSkillsDirectory({}), undefined);
});

it.effect("reports linked skills with their frontmatter name and description", () =>
  Effect.gen(function* () {
    const root = yield* makeTempDir;
    const canonical = yield* makeTempDir;
    const skillsDir = NodePath.join(root, "skills");
    yield* Effect.promise(() => NodeFSP.mkdir(skillsDir));

    // `skills/install.sh` links canonical skill directories, so the entry is a
    // symlink rather than a real directory.
    const planEpic = yield* writeSkill(
      canonical,
      "plan-epic",
      "---\nname: plan-epic\ndescription: Plan a large piece of work as a beads epic\n---\n\nBody\n",
    );
    yield* Effect.promise(() =>
      NodeFSP.symlink(planEpic, NodePath.join(skillsDir, "plan-epic"), "dir"),
    );
    yield* writeSkill(skillsDir, "cook-epic", "no frontmatter here\n");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(skillsDir, "README.md"), "not a skill", "utf8"),
    );
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(skillsDir, "empty-dir")));

    const skills = yield* readPrimeSkills({ PRIME_SKILLS_DIR: skillsDir });
    assert.deepStrictEqual(
      skills.map((skill) => skill.name),
      ["cook-epic", "plan-epic"],
    );
    const planned = skills.find((skill) => skill.name === "plan-epic");
    assert.strictEqual(planned?.description, "Plan a large piece of work as a beads epic");
    assert.strictEqual(planned?.enabled, true);
    assert.strictEqual(planned?.scope, "user");
    assert.strictEqual(planned?.path, NodePath.join(skillsDir, "plan-epic", "SKILL.md"));
  }),
);

it.effect("reports no skills when the directory is missing or unknown", () =>
  Effect.gen(function* () {
    const root = yield* makeTempDir;
    assert.deepStrictEqual(
      yield* readPrimeSkills({ PRIME_HOME: NodePath.join(root, "absent") }),
      [],
    );
    assert.deepStrictEqual(yield* readPrimeSkills({}), []);
  }),
);

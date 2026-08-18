// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { parseSkillFrontmatter } from "../../skills/SkillCommandRegistry.ts";

const SKILL_DIRECTORY_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MISSING_DIRECTORY_CODES = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Resolve the directory Prime loads skills from. This mirrors the resolution
 * in `skills/install.sh`, so the skills T3 Code reports are the ones the
 * installer linked. Returns `undefined` when no home directory is known.
 */
export function resolvePrimeSkillsDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  const explicit = environment.PRIME_SKILLS_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const primeHome = environment.PRIME_HOME?.trim();
  if (primeHome) {
    return NodePath.join(primeHome, "skills");
  }
  const home = environment.HOME?.trim();
  return home ? NodePath.join(home, ".prime", "skills") : undefined;
}

function isMissingDirectory(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && MISSING_DIRECTORY_CODES.has(code);
}

async function scan(directory: string): Promise<ReadonlyArray<ServerProviderSkill>> {
  let entries;
  try {
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch (error) {
    // Prime is not installed, or it keeps no skills. Neither is a failure.
    if (isMissingDirectory(error)) return [];
    throw error;
  }

  const skills = new Map<string, ServerProviderSkill>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const skillDirectory = NodePath.join(directory, entry.name);
    const skillPath = NodePath.join(skillDirectory, "SKILL.md");
    let content: string;
    try {
      // `install.sh` links skills, so stat instead of trusting the dirent.
      const directoryStat = await NodeFSP.stat(skillDirectory);
      if (!directoryStat.isDirectory()) continue;
      content = await NodeFSP.readFile(skillPath, "utf8");
    } catch {
      // Missing or unreadable entries are not skills.
      continue;
    }
    const parsed = parseSkillFrontmatter(content);
    const name = parsed?.name ?? (SKILL_DIRECTORY_NAME.test(entry.name) ? entry.name : undefined);
    if (!name || skills.has(name)) continue;
    skills.set(name, {
      name,
      ...(parsed?.description ? { description: parsed.description } : {}),
      path: skillPath,
      scope: "user",
      enabled: true,
    });
  }
  return [...skills.values()];
}

/**
 * List the skills a Prime instance can run as `/skill:<name>`. Prime reports
 * no skills over RPC, so the snapshot is built from its skills directory.
 * Never fails: an unreadable directory reports no skills, which falls back to
 * expanding the workspace skill body inline.
 */
export const readPrimeSkills = Effect.fn("readPrimeSkills")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>> {
  const directory = resolvePrimeSkillsDirectory(environment);
  if (directory === undefined) {
    return [];
  }
  return yield* Effect.tryPromise(() => scan(directory)).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("prime skills directory scan failed; reporting no skills", {
        directory,
        cause,
      }).pipe(Effect.as([])),
    ),
  );
});

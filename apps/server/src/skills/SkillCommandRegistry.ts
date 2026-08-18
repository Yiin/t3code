// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface SkillCommand {
  readonly name: string;
  readonly description?: string;
  readonly content: string;
}

interface CacheEntry {
  readonly fingerprint: string;
  readonly commands: ReadonlyMap<string, SkillCommand>;
}

export interface SkillCommandRegistry {
  readonly find: (root: string, name: string) => Effect.Effect<SkillCommand | undefined>;
  readonly list: (root: string) => Effect.Effect<ReadonlyArray<Omit<SkillCommand, "content">>>;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A YAML block scalar header: `>`, `|`, plus optional indent and chomp indicators. */
const BLOCK_SCALAR = /^[>|][0-9]*[+-]?$/;

/**
 * Join the lines of a folded (`>`) block scalar: a blank line starts a new
 * paragraph, and everything else runs together separated by a space.
 */
function foldBlockLines(lines: ReadonlyArray<string>): string {
  let folded = "";
  for (const line of lines) {
    if (line === "") {
      folded += "\n";
      continue;
    }
    folded += folded === "" || folded.endsWith("\n") ? line : ` ${line}`;
  }
  return folded;
}

/**
 * Read a skill's `name` and `description` out of its SKILL.md frontmatter.
 * Exported so provider-side skill discovery (Prime lists its own skills
 * directory) parses skills exactly the way workspace skills are parsed.
 */
export function parseSkillFrontmatter(content: string): Omit<SkillCommand, "content"> | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) return undefined;

  const values = new Map<string, string>();
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(lines[index] ?? "");
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    // `description: >` and `description: |` put the value on the following
    // indented lines. Reading the header as the value hands the UI a ">".
    if (BLOCK_SCALAR.test(rawValue)) {
      const block: Array<string> = [];
      let cursor = index + 1;
      for (; cursor < end; cursor += 1) {
        const next = lines[cursor] ?? "";
        if (next.trim() === "") {
          block.push("");
          continue;
        }
        if (!/^\s/.test(next)) break;
        block.push(next.trim());
      }
      index = cursor - 1;
      const value = rawValue.startsWith(">") ? foldBlockLines(block) : block.join("\n");
      values.set(key, value.trim());
      continue;
    }
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
    values.set(key, value);
  }

  const name = values.get("name");
  if (!name || !SKILL_NAME.test(name)) return undefined;
  const description = values.get("description");
  return { name, ...(description ? { description } : {}) };
}

async function scan(root: string, cached: CacheEntry | undefined): Promise<CacheEntry> {
  const rootPath = NodePath.resolve(root);
  const rootStat = await NodeFSP.stat(rootPath);
  const entries = (await NodeFSP.readdir(rootPath, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const fingerprintParts = [`root:${rootStat.mtimeMs}`];
  const candidates: Array<{ readonly content: string }> = [];

  for (const entry of entries) {
    const directory = NodePath.join(rootPath, entry.name);
    try {
      const directoryStat = await NodeFSP.stat(directory);
      if (!directoryStat.isDirectory()) continue;
      const skillPath = NodePath.join(directory, "SKILL.md");
      const skillStat = await NodeFSP.stat(skillPath);
      if (!skillStat.isFile()) continue;
      const content = await NodeFSP.readFile(skillPath, "utf8");
      const contentHash = NodeCrypto.createHash("sha256").update(content).digest("hex");
      fingerprintParts.push(
        `${entry.name}:${directoryStat.mtimeMs}:${skillStat.mtimeMs}:${skillStat.size}:${contentHash}`,
      );
      candidates.push({ content });
    } catch {
      // Missing or inaccessible entries are not commands.
    }
  }

  const fingerprint = fingerprintParts.join("|");
  if (cached?.fingerprint === fingerprint) return cached;

  const commands = new Map<string, SkillCommand>();
  for (const candidate of candidates) {
    const parsed = parseSkillFrontmatter(candidate.content);
    if (parsed && !commands.has(parsed.name)) {
      commands.set(parsed.name, { ...parsed, content: candidate.content });
    }
  }

  return { fingerprint, commands };
}

/**
 * Skill directories inside a project's workspace root, searched before the
 * global skills root so a project's own skills shadow global ones with the
 * same name. Search order: `.claude/skills`, then `.agents/skills`.
 */
export function projectSkillRoots(workspaceRoot: string): ReadonlyArray<string> {
  return [
    NodePath.join(workspaceRoot, ".claude", "skills"),
    NodePath.join(workspaceRoot, ".agents", "skills"),
  ];
}

async function isDirectory(root: string): Promise<boolean> {
  try {
    return (await NodeFSP.stat(root)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Search multiple skill roots in order, first match wins. Most projects
 * lack `.claude/skills` or `.agents/skills`, so missing roots are skipped
 * before calling into the registry instead of scanning and logging a
 * warning on every lookup.
 */
export const findAcrossSkillRoots = (
  registry: SkillCommandRegistry,
  roots: ReadonlyArray<string>,
  name: string,
): Effect.Effect<SkillCommand | undefined> =>
  Effect.gen(function* () {
    for (const root of roots) {
      const exists = yield* Effect.promise(() => isDirectory(root));
      if (!exists) continue;
      const found = yield* registry.find(root, name);
      if (found !== undefined) return found;
    }
    return undefined;
  });

/**
 * List multiple skill roots in order, deduplicating by name with earlier
 * roots winning — the same precedence {@link findAcrossSkillRoots} uses.
 */
export const listAcrossSkillRoots = (
  registry: SkillCommandRegistry,
  roots: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<Omit<SkillCommand, "content">>> =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const commands: Array<Omit<SkillCommand, "content">> = [];
    for (const root of roots) {
      const exists = yield* Effect.promise(() => isDirectory(root));
      if (!exists) continue;
      for (const command of yield* registry.list(root)) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        commands.push(command);
      }
    }
    return commands;
  });

/**
 * The listing shape: every parsed command minus its body. Dropping `content`
 * by rest-destructuring keeps an absent `description` absent.
 */
function summarizeCommands(entry: CacheEntry): ReadonlyArray<Omit<SkillCommand, "content">> {
  return Array.from(entry.commands.values(), ({ content: _content, ...command }) => command);
}

export const makeSkillCommandRegistry = Effect.fn("makeSkillCommandRegistry")(function* () {
  const cache = yield* Ref.make(new Map<string, CacheEntry>());
  const scanSemaphore = yield* Semaphore.make(1);

  const find: SkillCommandRegistry["find"] = (root, name) =>
    scanSemaphore.withPermits(1)(
      Ref.get(cache).pipe(
        Effect.flatMap((current) =>
          Effect.tryPromise(() => scan(root, current.get(NodePath.resolve(root)))),
        ),
        Effect.flatMap((next) =>
          Ref.modify(cache, (current) => {
            const cached = current.get(NodePath.resolve(root));
            if (cached?.fingerprint === next.fingerprint) {
              return [cached.commands.get(name), current] as const;
            }
            const updated = new Map(current);
            updated.set(NodePath.resolve(root), next);
            return [next.commands.get(name), updated] as const;
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("skill command registry scan failed; passing command through", {
            root,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      ),
    );

  const list: SkillCommandRegistry["list"] = (root) =>
    scanSemaphore.withPermits(1)(
      Ref.get(cache).pipe(
        Effect.flatMap((current) =>
          Effect.tryPromise(() => scan(root, current.get(NodePath.resolve(root)))),
        ),
        Effect.flatMap((next) =>
          Ref.modify(cache, (current) => {
            const cached = current.get(NodePath.resolve(root));
            if (cached?.fingerprint === next.fingerprint) {
              return [summarizeCommands(cached), current] as const;
            }
            const updated = new Map(current);
            updated.set(NodePath.resolve(root), next);
            return [summarizeCommands(next), updated] as const;
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("skill command registry scan failed; returning no commands", {
            root,
            cause,
          }).pipe(Effect.as([])),
        ),
      ),
    );

  return { find, list } satisfies SkillCommandRegistry;
});

export const parseSkillCommand = (
  input: string,
): { readonly name: string; readonly arguments: string } | undefined => {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)/.exec(input);
  if (!match?.[1]) return undefined;
  return {
    name: match[1],
    arguments: input.slice(match[0].length).trimStart(),
  };
};

/**
 * Parse a leading `$name` skill invocation — the composer's provider-neutral
 * skill syntax. The name charset matches the composer's inline skill token
 * (`collectComposerInlineTokens`), which is wider than workspace skill names
 * so provider-native skills (e.g. `plugin:skill`) parse too.
 */
export const parseSkillInvocation = (
  input: string,
): { readonly name: string; readonly arguments: string } | undefined => {
  const match = /^\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/.exec(input);
  if (!match?.[1]) return undefined;
  return {
    name: match[1],
    arguments: input.slice(match[0].length).trimStart(),
  };
};

export function expandSkillCommand(skill: SkillCommand, argumentsText: string): string {
  return `The user invoked the /${skill.name} skill. Follow its instructions below.\n\n${skill.content}\n\nARGUMENTS: ${argumentsText}`;
}

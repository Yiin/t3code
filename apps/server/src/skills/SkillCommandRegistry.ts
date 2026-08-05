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

function parseFrontmatter(content: string): Omit<SkillCommand, "content"> | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) return undefined;

  const values = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
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
    const parsed = parseFrontmatter(candidate.content);
    if (parsed && !commands.has(parsed.name)) {
      commands.set(parsed.name, { ...parsed, content: candidate.content });
    }
  }

  return { fingerprint, commands };
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
            const entry = cached?.fingerprint === next.fingerprint ? cached : next;
            if (entry === cached) {
              return [
                Array.from(entry.commands.values(), ({ name, description }) => ({
                  name,
                  ...(description ? { description } : {}),
                })),
                current,
              ] as const;
            }
            const updated = new Map(current);
            updated.set(NodePath.resolve(root), next);
            return [
              Array.from(next.commands.values(), ({ name, description }) => ({
                name,
                ...(description ? { description } : {}),
              })),
              updated,
            ] as const;
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

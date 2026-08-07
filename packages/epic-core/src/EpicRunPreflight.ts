import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  EpicRunPreflightError,
  type EpicRunConfig,
  type EpicRunConfigOverride,
  type EpicRunConfigProvenance,
  type EpicRunPreflightBlocker,
  type EpicRunPreflightInput,
  type EpicRunPreflightResult,
  type EpicRunPreflightWarning,
} from "@t3tools/contracts";
import { resolveEpicRunConfig, type EpicRunConfigViolation } from "@t3tools/shared/epicRunConfig";

import { EpicRunConfigSource, type EpicRunConfigFileResult } from "./EpicRunConfigSource.ts";
import { EpicRunLock } from "./ports/EpicRunLock.ts";
import { ProcessRunner } from "./processRunner.ts";

const COMMAND_TIMEOUT = Duration.seconds(20);
const MAX_BLOCKER_TEXT_LENGTH = 2_048;

function boundedBlockerText(value: string): string {
  return value.length <= MAX_BLOCKER_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_BLOCKER_TEXT_LENGTH - 3)}...`;
}

export function formatEpicRunPreflightBlocker(blocker: EpicRunPreflightBlocker): string {
  switch (blocker._tag) {
    case "dirty_tree":
      return boundedBlockerText(`The worktree has changes: ${blocker.paths.join(", ")}`);
    case "detached_head":
      return "The repository has a detached HEAD.";
    case "run_in_progress":
      return boundedBlockerText(
        `Another epic run owns this repository on ${blocker.host} (PID ${String(blocker.pid)}, ${blocker.runDir}).`,
      );
    case "epic_not_found":
      return boundedBlockerText(`Epic ${blocker.epicId} was not found.`);
    case "config_invalid":
      return boundedBlockerText(`${blocker.configPath}\n${blocker.diagnostics.join("\n")}`);
  }
}

export interface EpicRunPreflightShape {
  readonly check: (
    input: EpicRunPreflightInput,
    configSnapshot?: EpicRunConfigSnapshot,
  ) => Effect.Effect<EpicRunPreflightResult, EpicRunPreflightError>;
}

/** The immutable config view shared by launch and preflight. */
export interface EpicRunConfigSnapshot {
  readonly fileResult: EpicRunConfigFileResult;
  readonly config: EpicRunConfig;
  readonly provenance: EpicRunConfigProvenance;
  readonly violations: readonly EpicRunConfigViolation[];
}

export const makeEpicRunConfigSnapshot = (input: {
  readonly fileResult: EpicRunConfigFileResult;
  readonly override: EpicRunConfigOverride | null;
  readonly harness: string | null;
}): EpicRunConfigSnapshot => ({
  fileResult: input.fileResult,
  ...resolveEpicRunConfig({
    file: input.fileResult._tag === "loaded" ? input.fileResult.override : null,
    environment: null,
    override: input.override,
    harness: input.harness,
  }),
});

export class EpicRunPreflight extends Context.Service<EpicRunPreflight, EpicRunPreflightShape>()(
  "@t3tools/epic-core/EpicRunPreflight",
) {}

function parseArray(stdout: string): ReadonlyArray<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
        )
      : null;
  } catch {
    return null;
  }
}

function porcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) return line.slice(2);
  const firstTab = line.indexOf("\t");
  if (firstTab >= 0) return line.slice(0, firstTab).split(" ").at(-1) ?? null;
  const fields = line.split(" ");
  return fields.at(-1) ?? null;
}

function isBeadsPath(path: string): boolean {
  return path === ".beads" || path.startsWith(".beads/");
}

function deadLocalClaimIds(entries: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> {
  const ids: Array<string> = [];
  for (const entry of entries) {
    if (entry["status"] !== "in_progress" || typeof entry["id"] !== "string") continue;
    const actor =
      typeof entry["assignee"] === "string"
        ? entry["assignee"]
        : typeof entry["claim_actor"] === "string"
          ? entry["claim_actor"]
          : "";
    const match = /^t3code-(?:runner-)?(\d+)$/.exec(actor);
    if (match === null) continue;
    const pid = Number(match[1]);
    try {
      process.kill(pid, 0);
    } catch {
      ids.push(entry["id"]);
    }
  }
  return ids;
}

export const layer = Layer.effect(
  EpicRunPreflight,
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    const lock = yield* EpicRunLock;
    const configSource = yield* EpicRunConfigSource;

    const runBd = Effect.fn("EpicRunPreflight.runBd")(function* (
      cwd: string,
      args: ReadonlyArray<string>,
    ) {
      const result = yield* processRunner
        .run({ command: "bd", args, cwd, timeout: COMMAND_TIMEOUT })
        .pipe(
          Effect.mapError(
            (error) =>
              new EpicRunPreflightError({
                message: `bd ${args[0] ?? ""}: ${error.message}`,
              }),
          ),
        );
      return result;
    });

    const check: EpicRunPreflightShape["check"] = Effect.fn("EpicRunPreflight.check")(
      function* (input, suppliedConfigSnapshot) {
        const blockers: Array<EpicRunPreflightResult["blockers"][number]> = [];
        const warnings: Array<EpicRunPreflightWarning> = [];

        const status = yield* processRunner
          .run({
            command: "git",
            cwd: input.workspaceRoot,
            args: ["status", "--porcelain=2", "--branch", "--untracked-files=all"],
            timeout: COMMAND_TIMEOUT,
          })
          .pipe(
            Effect.mapError(
              (error) => new EpicRunPreflightError({ message: `git status: ${error.message}` }),
            ),
          );
        if (status.code !== 0) {
          return yield* new EpicRunPreflightError({
            message: `git status: ${status.stderr.trim() || `git exited ${String(status.code)}`}`,
          });
        }
        let detached = true;
        const dirtyPaths = new Set<string>();
        for (const line of status.stdout.split(/\r?\n/)) {
          if (line.startsWith("# branch.head ")) {
            detached = line.slice("# branch.head ".length).trim().startsWith("(");
          } else if (line.length > 0 && !line.startsWith("#")) {
            const path = porcelainPath(line);
            if (path !== null && !isBeadsPath(path)) dirtyPaths.add(path);
          }
        }
        if (detached) blockers.push({ _tag: "detached_head" });
        if (dirtyPaths.size > 0) {
          blockers.push({ _tag: "dirty_tree", paths: [...dirtyPaths].toSorted() });
        }

        const configSnapshot =
          suppliedConfigSnapshot ??
          makeEpicRunConfigSnapshot({
            fileResult: yield* configSource.read({ repoRoot: input.workspaceRoot }),
            override: { execution: { sequential: input.mode === "sequential" } },
            harness: null,
          });
        const configFile = configSnapshot.fileResult;
        if (configFile._tag === "invalid") {
          blockers.push({
            _tag: "config_invalid",
            configPath: configFile.configPath,
            diagnostics: configFile.diagnostics,
          });
        } else {
          if (configFile._tag === "loaded" && configFile.unknownKeys.length > 0) {
            warnings.push({
              _tag: "config_unknown_keys",
              configPath: configFile.configPath,
              keys: configFile.unknownKeys,
            });
          }
          for (const violation of configSnapshot.violations) {
            if (violation.key === "gate.command") {
              blockers.push({
                _tag: "config_invalid",
                configPath:
                  configFile._tag === "loaded"
                    ? configFile.configPath
                    : `${input.workspaceRoot}/.t3code/epic-run.json`,
                diagnostics: [violation.message],
              });
            } else {
              warnings.push({ _tag: "config_violation", ...violation });
            }
          }
        }

        const held = yield* lock
          .inspect({
            workspaceRoot: input.workspaceRoot,
            epicId: input.epicId,
          })
          .pipe(Effect.mapError((error) => new EpicRunPreflightError({ message: error.message })));
        if (
          held !== undefined &&
          typeof held.owner === "string" &&
          typeof held.runDir === "string" &&
          typeof held.host === "string" &&
          typeof held.pid === "number"
        ) {
          blockers.push({
            _tag: "run_in_progress",
            owner: held.owner,
            runDir: held.runDir,
            host: held.host,
            pid: held.pid,
          });
        }

        const shown = yield* runBd(input.workspaceRoot, ["show", input.epicId, "--json"]);
        if (shown.code !== 0 || parseArray(shown.stdout)?.length !== 1) {
          blockers.push({ _tag: "epic_not_found", epicId: input.epicId });
        } else {
          const ready = yield* runBd(input.workspaceRoot, [
            "ready",
            "--parent",
            input.epicId,
            "--json",
          ]);
          const readyEntries = ready.code === 0 ? parseArray(ready.stdout) : null;
          if (readyEntries === null) {
            return yield* new EpicRunPreflightError({
              message: `bd ready: ${ready.stderr.trim() || "bd returned invalid JSON"}`,
            });
          }
          if (readyEntries.length === 0) {
            warnings.push({ _tag: "nothing_ready", epicId: input.epicId });
          }

          const children = yield* runBd(input.workspaceRoot, [
            "list",
            "--parent",
            input.epicId,
            "--json",
          ]);
          const childEntries = children.code === 0 ? parseArray(children.stdout) : null;
          if (childEntries === null) {
            return yield* new EpicRunPreflightError({
              message: `bd list: ${children.stderr.trim() || "bd returned invalid JSON"}`,
            });
          }
          const childIds = deadLocalClaimIds(childEntries);
          if (childIds.length > 0) warnings.push({ _tag: "stale_claims", childIds });
        }

        return { ok: blockers.length === 0, blockers, warnings };
      },
    );

    return EpicRunPreflight.of({ check });
  }),
);

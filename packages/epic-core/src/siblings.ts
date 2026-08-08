import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ProcessRunner,
  type ProcessRunError,
  type ProcessRunInput,
  type ProcessRunOutput,
} from "./processRunner.ts";

const COMMAND_TIMEOUT = Duration.seconds(20);

/**
 * A sibling repository validated for a run: the canonical checkout path, the
 * branch it was on at validation time, and its forward-slash path relative to
 * the main repository root (e.g. `../proga-api`).
 */
export interface SiblingRef {
  readonly canonicalPath: string;
  readonly baseBranch: string;
  readonly relativePath: string;
}

export const SiblingValidationReason = Schema.Literals([
  "not-found",
  "not-git-repo",
  "detached-head",
  "dirty-tree",
  "no-origin-remote",
  "relative-path-unresolvable",
  "nested-in-main-repo",
  "escapes-layout-root",
  "duplicate-mirror",
  "command-failed",
]);
export type SiblingValidationReason = typeof SiblingValidationReason.Type;

/**
 * One sibling validation miss. `detail` carries the legacy operator hint
 * (`skills/cook-epic/run-legacy.sh:244-276`), with the configuration knobs
 * named as they exist now (`parallel.siblings`, `vcs.noPush`).
 */
export class SiblingValidationError extends Schema.TaggedErrorClass<SiblingValidationError>()(
  "SiblingValidationError",
  {
    path: Schema.String,
    reason: SiblingValidationReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Pure `realpath -m` semantics: lexical absolute-path normalization with no
 * filesystem access — resolves `.`/`..` segments (`..` at the root stays at
 * the root) and collapses duplicate slashes (`skills/cook-epic/run-legacy.sh:264`).
 */
export const normalizeAbsolutePath = (path: string): string => {
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

/** The sibling worktree's position inside a worker layout (`skills/cook-epic/run-legacy.sh:1019-1021`). */
export const mirrorPath = (layoutRoot: string, repoBasename: string, rel: string): string =>
  normalizeAbsolutePath(`${layoutRoot}/${repoBasename}/${rel}`);

/** Symbolic root the mirror rules are validated against (`skills/cook-epic/run-legacy.sh:263`). */
export const LAYOUT_PROBE_ROOT = "/cook-epic-layout-probe";

export type MirrorRejectReason = "nested-in-main-repo" | "escapes-layout-root" | "duplicate-mirror";

export interface MirrorAccept {
  readonly rel: string;
  readonly mirrored: string;
}

export interface MirrorReject {
  readonly rel: string;
  readonly mirrored: string;
  readonly reason: MirrorRejectReason;
  /** For `duplicate-mirror`, the earlier sibling relative path claiming the target. */
  readonly conflictsWith?: string;
}

export interface MirrorSetValidation {
  readonly accepted: ReadonlyArray<MirrorAccept>;
  readonly rejected: ReadonlyArray<MirrorReject>;
}

/**
 * The probe-root accept/reject rules of `skills/cook-epic/run-legacy.sh:255-271`:
 * reject when the mirrored path equals or nests under `<probe>/<repoBasename>`,
 * accept when it stays under `<probe>/`, reject otherwise, and reject two
 * siblings mirroring to the same path.
 */
export const validateMirrorSet = (
  repoBasename: string,
  rels: ReadonlyArray<string>,
): MirrorSetValidation => {
  const accepted: Array<MirrorAccept> = [];
  const rejected: Array<MirrorReject> = [];
  const seen = new Map<string, string>();
  const mainWorktree = `${LAYOUT_PROBE_ROOT}/${repoBasename}`;
  for (const rel of rels) {
    const mirrored = mirrorPath(LAYOUT_PROBE_ROOT, repoBasename, rel);
    if (mirrored === mainWorktree || mirrored.startsWith(`${mainWorktree}/`)) {
      rejected.push({ rel, mirrored, reason: "nested-in-main-repo" });
      continue;
    }
    if (!mirrored.startsWith(`${LAYOUT_PROBE_ROOT}/`)) {
      rejected.push({ rel, mirrored, reason: "escapes-layout-root" });
      continue;
    }
    const first = seen.get(mirrored);
    if (first !== undefined) {
      rejected.push({ rel, mirrored, reason: "duplicate-mirror", conflictsWith: first });
      continue;
    }
    seen.set(mirrored, rel);
    accepted.push({ rel, mirrored });
  }
  return { accepted, rejected };
};

/** The minimal process-runner port the resolver needs (git and realpath). */
export type SiblingProcessRun = (
  input: ProcessRunInput,
) => Effect.Effect<ProcessRunOutput, ProcessRunError>;

export interface ResolveSiblingsInput {
  /** Main repository root; sibling entries resolve relative to it. */
  readonly cwd: string;
  readonly siblings: ReadonlyArray<string>;
  readonly pushEnabled: boolean;
  readonly layoutMode: boolean;
}

export interface SiblingResolver {
  readonly resolveSiblings: (
    input: ResolveSiblingsInput,
  ) => Effect.Effect<ReadonlyArray<SiblingRef>, SiblingValidationError>;
}

/**
 * Validation rules 1-5 of `skills/cook-epic/run-legacy.sh:243-256` per sibling,
 * in legacy order, then rules 6-7 via {@link validateMirrorSet} when layout
 * mode is on. The first miss fails the effect, mirroring the legacy `die`.
 */
export const makeSiblingResolver = (run: SiblingProcessRun): SiblingResolver => {
  const runCommand = Effect.fn("siblings.runCommand")(function* (
    path: string,
    input: ProcessRunInput,
  ) {
    return yield* run({ timeout: COMMAND_TIMEOUT, ...input }).pipe(
      Effect.mapError(
        (error) =>
          new SiblingValidationError({
            path,
            reason: "command-failed",
            detail: `could not run '${input.command} ${input.args.join(" ")}': ${error.message}`,
          }),
      ),
    );
  });

  const resolveSiblings = Effect.fn("siblings.resolveSiblings")(function* (
    input: ResolveSiblingsInput,
  ) {
    // No siblings configured: no process invocations at all.
    if (input.siblings.length === 0) return [] as ReadonlyArray<SiblingRef>;
    // Legacy $REPO is canonical; canonicalize the root once so relative paths
    // and the layout geometry are computed against the real location.
    const rootResult = yield* runCommand(input.cwd, {
      command: "realpath",
      args: [input.cwd],
      cwd: input.cwd,
    });
    if (rootResult.code !== 0) {
      return yield* new SiblingValidationError({
        path: input.cwd,
        reason: "command-failed",
        detail: `cannot resolve the project root '${input.cwd}'`,
      });
    }
    const repoRoot = rootResult.stdout.trim();

    const resolved: Array<SiblingRef> = [];
    for (const entry of input.siblings) {
      // Rule 1 (run-legacy.sh:244-245): the path must exist.
      const canonicalResult = yield* runCommand(entry, {
        command: "realpath",
        args: [entry],
        cwd: repoRoot,
      });
      if (canonicalResult.code !== 0) {
        return yield* new SiblingValidationError({
          path: entry,
          reason: "not-found",
          detail: `sibling repo '${entry}' does not exist; parallel.siblings entries must be existing git repos relative to the project root`,
        });
      }
      const canonical = canonicalResult.stdout.trim();

      // Rule 2 (run-legacy.sh:246-247): it must be a git repository.
      const gitDir = yield* runCommand(canonical, {
        command: "git",
        args: ["-C", canonical, "rev-parse", "--git-dir"],
        cwd: repoRoot,
      });
      if (gitDir.code !== 0) {
        return yield* new SiblingValidationError({
          path: canonical,
          reason: "not-git-repo",
          detail: `sibling repo '${canonical}' is not a git repository; parallel.siblings entries must be git repos relative to the project root`,
        });
      }

      // Rule 3 (run-legacy.sh:248-249): it must be on a branch, recorded as
      // the sibling's base branch.
      const symbolicRef = yield* runCommand(canonical, {
        command: "git",
        args: ["-C", canonical, "symbolic-ref", "--short", "HEAD"],
        cwd: repoRoot,
      });
      if (symbolicRef.code !== 0 || symbolicRef.stdout.trim() === "") {
        return yield* new SiblingValidationError({
          path: canonical,
          reason: "detached-head",
          detail: `sibling repo '${canonical}' is not on a branch; check out a branch there before launching`,
        });
      }
      const baseBranch = symbolicRef.stdout.trim();

      // Rule 4 (run-legacy.sh:250-252): no tracked modifications, .beads excluded.
      yield* runCommand(canonical, {
        command: "git",
        args: ["-C", canonical, "update-index", "--refresh", "-q"],
        cwd: repoRoot,
      }).pipe(Effect.catch(() => Effect.void));
      const diffIndex = yield* runCommand(canonical, {
        command: "git",
        args: ["-C", canonical, "diff-index", "--quiet", "HEAD", "--", ".", ":(exclude).beads"],
        cwd: repoRoot,
      });
      if (diffIndex.code !== 0) {
        return yield* new SiblingValidationError({
          path: canonical,
          reason: "dirty-tree",
          detail: `sibling repo '${canonical}' has uncommitted changes; commit or stash there before launching — workers commit on its branch`,
        });
      }

      // Rule 5 (run-legacy.sh:253-256): an origin remote when pushing is enabled.
      if (input.pushEnabled) {
        const origin = yield* runCommand(canonical, {
          command: "git",
          args: ["-C", canonical, "remote", "get-url", "origin"],
          cwd: repoRoot,
        });
        if (origin.code !== 0) {
          return yield* new SiblingValidationError({
            path: canonical,
            reason: "no-origin-remote",
            detail: `sibling repo '${canonical}' has no origin remote; add an origin remote or set vcs.noPush for local-only landing`,
          });
        }
      }

      const relativeResult = yield* runCommand(canonical, {
        command: "realpath",
        args: [`--relative-to=${repoRoot}`, canonical],
        cwd: repoRoot,
      });
      if (relativeResult.code !== 0 || relativeResult.stdout.trim() === "") {
        // run-legacy.sh:258-259 (layout mode); the relative path is part of
        // SiblingRef, so an unresolvable one fails in both modes.
        return yield* new SiblingValidationError({
          path: canonical,
          reason: "relative-path-unresolvable",
          detail: `cannot compute the relative path from ${repoRoot} to sibling '${canonical}'; siblings must be reachable by a relative path from the project root`,
        });
      }

      resolved.push({
        canonicalPath: canonical,
        baseBranch,
        relativePath: relativeResult.stdout.trim(),
      });
    }

    // Rules 6-7 (run-legacy.sh:257-277): mirrorability and distinct targets.
    if (input.layoutMode) {
      const repoBasename = normalizeAbsolutePath(repoRoot).split("/").at(-1) ?? "";
      const mirrors = validateMirrorSet(
        repoBasename,
        resolved.map((sibling) => sibling.relativePath),
      );
      const rejection = mirrors.rejected[0];
      if (rejection !== undefined) {
        const canonical =
          resolved.find((sibling) => sibling.relativePath === rejection.rel)?.canonicalPath ??
          rejection.rel;
        const detail =
          rejection.reason === "nested-in-main-repo"
            ? `sibling repo '${canonical}' resolves inside the main repository; parallel layouts cannot mirror it — move the sibling outside the project root or run sequentially`
            : rejection.reason === "escapes-layout-root"
              ? `sibling repo '${canonical}' escapes the worker layout root (relative path '${rejection.rel}' cannot be mirrored); place siblings beside the project root or run sequentially`
              : `sibling repos '${canonical}' and '${
                  resolved.find((sibling) => sibling.relativePath === rejection.conflictsWith)
                    ?.canonicalPath ?? rejection.conflictsWith
                }' mirror to the same layout path; give the siblings distinct relative positions`;
        return yield* new SiblingValidationError({
          path: canonical,
          reason: rejection.reason,
          detail,
        });
      }
    }

    return resolved;
  });

  return { resolveSiblings };
};

/** Resolve siblings with the ambient {@link ProcessRunner}. */
export const resolveSiblings = (
  input: ResolveSiblingsInput,
): Effect.Effect<ReadonlyArray<SiblingRef>, SiblingValidationError, ProcessRunner> =>
  Effect.flatMap(ProcessRunner, (runner) => makeSiblingResolver(runner.run).resolveSiblings(input));

/**
 * Sequential-mode worker prompt rule naming the real checkouts
 * (`skills/cook-epic/run-legacy.sh:737-739`).
 */
export const siblingRuleSequential = (input: {
  readonly siblings: ReadonlyArray<{ readonly canonicalPath: string }>;
}): string =>
  `This child may span sibling repositories: ${input.siblings
    .map((sibling) => sibling.canonicalPath)
    .join(
      " ",
    )} (relative to the project root). You may read, write, build, and commit in them — commit on their current branch, never push; the coordinator pushes whatever moved after the gate. Say which repos gained commits in your close-out note.`;

/**
 * Per-worker layout prompt rule (`skills/cook-epic/run-legacy.sh:1998-2004`).
 * The legacy `local SIBLING_RULE="$SIBLING_RULE"` dynamic-scope trick becomes
 * these explicit parameters.
 */
export const siblingRuleLayout = (input: {
  readonly layoutRoot: string;
  readonly layout: string;
  readonly repoBasename: string;
  readonly branch: string;
  readonly siblings: ReadonlyArray<SiblingRef>;
}): string => {
  const sibPaths = input.siblings
    .map(
      (sibling) =>
        `\`${mirrorPath(input.layout, input.repoBasename, sibling.relativePath)}\` (mirror of \`${sibling.relativePath}\`)`,
    )
    .join(", ");
  const realPaths = input.siblings.map((sibling) => `\`${sibling.canonicalPath}\``).join(", ");
  const firstRel = input.siblings[0]?.relativePath ?? "";
  return `This child may span sibling repositories. Your sandbox is the whole layout \`${input.layout}\`: it holds your main-repo worktree plus one worktree per sibling at its real relative position — ${sibPaths} — so relative references like \`${firstRel}\` resolve from inside your main worktree. Every worktree in the layout is on branch \`${input.branch}\`; commit only on \`${input.branch}\` in whichever repos you touch. In sibling repos commit only and never push them — the coordinator trial-merges every repo you touched as one set, gates once, and lands them together. Never touch the real checkouts (${realPaths}) or any other layout under \`${input.layoutRoot}\`. Say which repos gained commits in your close-out note.`;
};

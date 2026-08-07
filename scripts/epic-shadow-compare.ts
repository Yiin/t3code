#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalProcess:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  comparatorSafetyViolations,
  compareTranscripts,
  normalizeCoreMailbox,
  normalizeLegacyMailbox,
  parseJsonLines,
  readTranscriptFile,
  requireTranscriptEpic,
} from "./lib/epic-shadow-compare.ts";

type Adapter = "terminal" | "core";
type Mode = "run" | "shadow";

interface Arguments {
  readonly epic: string;
  readonly cwd: string;
  readonly adapters: readonly [Adapter, Adapter];
  readonly mode: Mode;
  readonly transcriptDir: string | null;
}

interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");

const fail = (message: string): never => {
  throw new Error(message);
};

const parseArguments = (argv: ReadonlyArray<string>): Arguments => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      return fail(
        "Usage: epic-shadow-compare --epic <id> --cwd <repo> --adapters terminal,core [--mode run|shadow].",
      );
    }
    values.set(key, value);
  }
  const epic = values.get("--epic");
  const cwd = values.get("--cwd");
  if (!epic || !cwd) return fail("--epic and --cwd are required.");
  const adapters = (values.get("--adapters") ?? "terminal,core").split(",");
  if (
    adapters.length !== 2 ||
    !adapters.every((adapter) => adapter === "terminal" || adapter === "core") ||
    adapters[0] === adapters[1]
  ) {
    return fail("--adapters must contain terminal and core once each.");
  }
  const mode = values.get("--mode") ?? "run";
  if (mode !== "run" && mode !== "shadow") return fail("--mode must be run or shadow.");
  return {
    epic,
    cwd: NodePath.resolve(cwd),
    adapters: adapters as [Adapter, Adapter],
    mode,
    transcriptDir: values.get("--transcript-dir") ?? null,
  };
};

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProcessResult => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

const requireOk = (result: ProcessResult, operation: string): string => {
  if (result.status !== 0) {
    return fail(`${operation} failed (${String(result.status)}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

const json = (result: ProcessResult, operation: string): unknown => {
  const text = requireOk(result, operation);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${operation} returned invalid JSON: ${text.slice(0, 200)}`, { cause });
  }
};

const cleanEnvironment = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(base).filter(
      ([key]) =>
        !key.startsWith("COOKEPIC_") &&
        !key.startsWith("BEADS_DOLT_") &&
        key !== "BEADS_DIR" &&
        key !== "FLEET_UNIT",
    ),
  );

const defaultBranches = (cwd: string): ReadonlyArray<string> => {
  const remote = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  const remoteDefault = remote.status === 0 ? remote.stdout.trim().split("/").at(-1) : undefined;
  return [...new Set(["main", "master", "mine", remoteDefault].filter(Boolean) as string[])];
};

const configuredSiblingCount = (cwd: string): number => {
  const path = NodePath.join(cwd, ".t3code", "epic-run.json");
  if (!NodeFS.existsSync(path)) return 0;
  const value = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
    parallel?: { siblings?: unknown };
  };
  return Array.isArray(value.parallel?.siblings) ? value.parallel.siblings.length : 0;
};

const preflight = (input: Arguments): void => {
  const dirtyPaths = requireOk(
    run("git", ["status", "--porcelain", "--untracked-files=all"], input.cwd),
    "git status",
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  const branch = requireOk(run("git", ["branch", "--show-current"], input.cwd), "git branch");
  const where = json(run("bd", ["where", "--json"], input.cwd), "bd where") as {
    database_path?: unknown;
  };
  const host = run("bd", ["config", "get", "dolt.host"], input.cwd);
  const violations = comparatorSafetyViolations({
    dirtyPaths,
    branch,
    defaultBranches: defaultBranches(input.cwd),
    repoRoot: input.cwd,
    databasePath: typeof where.database_path === "string" ? where.database_path : "",
    doltHost: host.status === 0 && !host.stdout.includes("(not set") ? host.stdout.trim() : null,
    siblingCount: configuredSiblingCount(input.cwd),
    standaloneGitDirectory: NodeFS.statSync(NodePath.join(input.cwd, ".git")).isDirectory(),
  });
  if (violations.length > 0) return fail(violations.join("\n"));
};

const copySnapshot = (source: string, target: string): void => {
  NodeFS.cpSync(source, target, { recursive: true, preserveTimestamps: true });
};

const adapterEnvironment = (): NodeJS.ProcessEnv => ({
  ...cleanEnvironment(process.env),
  ...(process.env.EPIC_SHADOW_WORKER_CMD === undefined
    ? {}
    : {
        COOKEPIC_HARNESS: "worker-cmd",
        COOKEPIC_WORKER_CMD: process.env.EPIC_SHADOW_WORKER_CMD,
        COOKEPIC_SPAWN_DELAY: "0",
        COOKEPIC_SUPERVISION_TICK: "0.1",
      }),
  COOKEPIC_SEQUENTIAL: "1",
  COOKEPIC_SIBLINGS: "",
  COOKEPIC_NO_PUSH: "1",
  COOKEPIC_NO_GATE: "1",
});

const runAdapter = (adapter: Adapter, input: Arguments, cwd: string, runDirectory: string) => {
  const environment = adapterEnvironment();
  const result =
    adapter === "terminal"
      ? run(NodePath.join(repositoryRoot, "skills", "cook-epic", "run.sh"), [runDirectory], cwd, {
          ...environment,
          COOKEPIC_EPIC: input.epic,
          COOKEPIC_CORE: "0",
        })
      : run(
          "node",
          [
            NodePath.join(repositoryRoot, "apps", "server", "src", "bin.ts"),
            "epic",
            "cook",
            "--epic",
            input.epic,
            "--cwd",
            cwd,
            "--run-dir",
            runDirectory,
            "--no-gate",
          ],
          cwd,
          environment,
        );
  requireOk(result, `${adapter} adapter`);
  const mailbox = parseJsonLines(
    NodeFS.readFileSync(NodePath.join(runDirectory, "mailbox.jsonl"), "utf8"),
  );
  const children = json(
    run("bd", ["list", "--parent", input.epic, "--all", "--json"], cwd, environment),
    `${adapter} child state`,
  );
  const childRecords = Array.isArray(children)
    ? children.filter(
        (child): child is Record<string, unknown> => typeof child === "object" && child !== null,
      )
    : [];
  const blockedIssueIds = new Set(
    childRecords.flatMap((child) =>
      child.status === "blocked" && typeof child.id === "string" ? [child.id] : [],
    ),
  );
  const transcript =
    adapter === "terminal"
      ? normalizeLegacyMailbox(mailbox, input.epic, {
          subagentLivenessUnavailable: process.env.EPIC_SHADOW_WORKER_CMD !== undefined,
        })
      : normalizeCoreMailbox(mailbox, input.epic, { blockedIssueIds });
  const commits = requireOk(
    run("git", ["log", "--format=%H%x09%s", "--reverse", "--topo-order"], cwd, environment),
    `${adapter} git log`,
  );
  const commitsPerChild =
    adapter === "terminal"
      ? mailbox.flatMap((value) => {
          const event: Record<string, unknown> =
            typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
          const issueId = "child" in event && typeof event.child === "string" ? event.child : null;
          return event.event === "done" && issueId !== null
            ? [
                {
                  issueId,
                  commits:
                    "commits" in event && typeof event.commits === "number" ? event.commits : null,
                },
              ]
            : [];
        })
      : mailbox.flatMap((value) => {
          const event =
            typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
          const iteration =
            typeof event.iteration === "object" && event.iteration !== null
              ? (event.iteration as Record<string, unknown>)
              : {};
          const issueId = typeof iteration.issueId === "string" ? iteration.issueId : null;
          const headBefore = typeof iteration.headBefore === "string" ? iteration.headBefore : null;
          const headAfter = typeof iteration.headAfter === "string" ? iteration.headAfter : null;
          if (
            event.type !== "iteration-state-changed" ||
            iteration.turnStatus !== "completed" ||
            issueId === null ||
            headBefore === null ||
            headAfter === null
          ) {
            return [];
          }
          const count = requireOk(
            run("git", ["rev-list", "--count", `${headBefore}..${headAfter}`], cwd, environment),
            `${adapter} commits for ${issueId}`,
          );
          return [{ issueId, commits: Number(count) }];
        });
  return { transcript, children, commits, commitsPerChild };
};

const printResult = (
  leftName: Adapter,
  rightName: Adapter,
  left: ReturnType<typeof runAdapter>,
  right: ReturnType<typeof runAdapter>,
): number => {
  const comparison = compareTranscripts(left.transcript, right.transcript);
  console.log(`structural divergences: ${String(comparison.structural.length)}`);
  console.log(`content divergences: ${String(comparison.content.length)}`);
  for (const divergence of comparison.divergences) {
    console.log(
      `${divergence.kind} at ${String(divergence.index)}\n${leftName}: ${JSON.stringify(divergence.left)}\n${rightName}: ${JSON.stringify(divergence.right)}`,
    );
  }
  console.log(`\n${leftName} commits\n${left.commits}\n\n${rightName} commits\n${right.commits}`);
  console.log(
    `\ncommits per child\n${leftName}: ${JSON.stringify(left.commitsPerChild)}\n${rightName}: ${JSON.stringify(right.commitsPerChild)}`,
  );
  console.log(
    `\nfinal child statuses\n${leftName}: ${JSON.stringify(left.children)}\n${rightName}: ${JSON.stringify(right.children)}`,
  );
  return comparison.structural.length === 0 ? 0 : 1;
};

const runMode = (input: Arguments): number => {
  preflight(input);
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "epic-shadow-compare-"));
  try {
    const beforeHead = requireOk(run("git", ["rev-parse", "HEAD"], input.cwd), "snapshot HEAD");
    const beforeBeads = requireOk(
      run("bd", ["list", "--parent", input.epic, "--all", "--json"], input.cwd),
      "snapshot Beads state",
    );
    const adapterRoots = input.adapters.map((adapter) => {
      const adapterRoot = NodePath.join(temporaryRoot, adapter);
      const cwd = NodePath.join(adapterRoot, "repo");
      const runDirectory = NodePath.join(adapterRoot, "run");
      NodeFS.mkdirSync(adapterRoot, { recursive: true });
      copySnapshot(input.cwd, cwd);
      return { adapter, cwd, runDirectory };
    });
    const afterHead = requireOk(run("git", ["rev-parse", "HEAD"], input.cwd), "verify HEAD");
    const afterBeads = requireOk(
      run("bd", ["list", "--parent", input.epic, "--all", "--json"], input.cwd),
      "verify Beads state",
    );
    const afterDirty = requireOk(
      run("git", ["status", "--porcelain", "--untracked-files=all"], input.cwd),
      "verify source status",
    );
    if (beforeHead !== afterHead || beforeBeads !== afterBeads || afterDirty !== "") {
      return fail("The source Git or Beads snapshot changed while the adapter copies were made.");
    }
    for (const { adapter, cwd } of adapterRoots) {
      const copiedHead = requireOk(run("git", ["rev-parse", "HEAD"], cwd), `${adapter} copy HEAD`);
      const copiedBeads = requireOk(
        run("bd", ["list", "--parent", input.epic, "--all", "--json"], cwd),
        `${adapter} copy Beads state`,
      );
      if (copiedHead !== beforeHead || copiedBeads !== beforeBeads) {
        return fail(`${adapter} did not receive the exact source Git and Beads snapshot.`);
      }
    }
    const results = adapterRoots.map(({ adapter, cwd, runDirectory }) => {
      return runAdapter(adapter, input, cwd, runDirectory);
    }) as [ReturnType<typeof runAdapter>, ReturnType<typeof runAdapter>];
    return printResult(input.adapters[0], input.adapters[1], results[0], results[1]);
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

const shadowMode = (input: Arguments): number => {
  const directory = NodePath.resolve(
    input.transcriptDir ?? NodePath.join(input.cwd, ".git", "t3code", "epic-shadow", input.epic),
  );
  const left = readTranscriptFile(NodePath.join(directory, `${input.adapters[0]}.jsonl`));
  const right = readTranscriptFile(NodePath.join(directory, `${input.adapters[1]}.jsonl`));
  requireTranscriptEpic(left, input.epic, input.adapters[0]);
  requireTranscriptEpic(right, input.epic, input.adapters[1]);
  return printResult(
    input.adapters[0],
    input.adapters[1],
    {
      transcript: left,
      children: [],
      commits: "shadow mode does not run adapters",
      commitsPerChild: [],
    },
    {
      transcript: right,
      children: [],
      commits: "shadow mode does not run adapters",
      commitsPerChild: [],
    },
  );
};

try {
  const input = parseArguments(process.argv.slice(2));
  process.exitCode = input.mode === "run" ? runMode(input) : shadowMode(input);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 2;
}

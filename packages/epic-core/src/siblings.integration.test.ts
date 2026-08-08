// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { drainMergeQueue, type MergeQueuePorts } from "./MergeQueue.ts";
import type { BacklogIssue } from "./ports/Backlog.ts";
import type {
  MergeGitShape,
  MergeQueueEntry,
  MergeQueueSnapshot,
  MergeQueueStoreShape,
} from "./ports/MergeQueue.ts";
import { mirrorPath } from "./siblings.ts";

const INTEGRATION_BRANCH = "cook-epic-integration-run-1";
const CHILD_BRANCH = "epic/child-1";

const gitResult = (cwd: string, args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
};

const git = (cwd: string, args: ReadonlyArray<string>): string => {
  const result = gitResult(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const head = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]);

const commitFile = (cwd: string, name: string, contents: string, message: string): string => {
  NodeFS.writeFileSync(NodePath.join(cwd, name), contents);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-q", "-m", message]);
  return head(cwd);
};

const initRepo = (path: string): void => {
  NodeFS.mkdirSync(path, { recursive: true });
  const init = NodeChildProcess.spawnSync("git", ["init", "-q", "-b", "main", path], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (init.status !== 0) throw new Error(`git init ${path}: ${init.stderr}`);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "user.name", "Test"]);
  commitFile(path, "start.txt", "start\n", "initial");
};

/** The two repositories: `<root>/main` with the sibling beside it at `<root>/sibling`. */
interface RepoFixture {
  readonly root: string;
  readonly main: string;
  readonly sibling: string;
}

const makeRepos = (): RepoFixture => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-siblings-"));
  const fixture = {
    root,
    main: NodePath.join(root, "main"),
    sibling: NodePath.join(root, "sibling"),
  };
  initRepo(fixture.main);
  initRepo(fixture.sibling);
  return fixture;
};

const withFixture = <A, E>(use: (fixture: RepoFixture) => Effect.Effect<A, E>) =>
  Effect.acquireRelease(Effect.sync(makeRepos), (fixture) =>
    Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(use), Effect.scoped);

/**
 * The layout provisioning sequence `makeServerPoolWorkspace.acquire` runs:
 * the main worktree at `<layout>/<repoBasename>` and one worktree per sibling
 * at its mirrored position (`skills/cook-epic/run-legacy.sh:1919-1953`).
 */
const provisionLayout = (fixture: RepoFixture, issueId: string, branch: string) => {
  const layout = NodePath.join(fixture.root, "layouts", issueId);
  const mainWorktree = NodePath.join(layout, "main");
  const siblingWorktree = mirrorPath(layout, "main", "../sibling");
  git(fixture.main, ["worktree", "add", mainWorktree, "-b", branch, "main"]);
  git(fixture.sibling, ["worktree", "add", siblingWorktree, "-b", branch, "main"]);
  return { layout, mainWorktree, siblingWorktree };
};

/** A MergeGitShape over the real git binary, mirroring the server adapter's commands. */
const makeRealMergeGit = (): MergeGitShape => ({
  head: (cwd) => Effect.sync(() => head(cwd)),
  commitsAhead: ({ repositoryPath, baseBranch, branch }) =>
    Effect.sync(() => {
      const exists = gitResult(repositoryPath, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      if (exists.status !== 0) return 0;
      const count = gitResult(repositoryPath, ["rev-list", "--count", `${baseBranch}..${branch}`]);
      return count.status === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0;
    }),
  resetHard: (cwd, ref) => Effect.sync(() => void git(cwd, ["reset", "--hard", ref])),
  clean: (cwd) => Effect.sync(() => void git(cwd, ["clean", "-fdx"])),
  setupWorktree: () => Effect.void,
  trialMerge: ({ cwd, branch, message }) =>
    Effect.sync(() => ({
      merged: gitResult(cwd, ["merge", "--no-ff", branch, "-m", message]).status === 0,
      output: "",
    })),
  abortMerge: (cwd) => Effect.sync(() => void git(cwd, ["merge", "--abort"])),
  fastForward: ({ cwd, ref }) =>
    Effect.sync(() => ({
      landed: gitResult(cwd, ["merge", "--ff-only", ref]).status === 0,
      output: "",
    })),
  push: ({ cwd, remote, refspec }) =>
    Effect.sync(() => ({
      pushed: gitResult(cwd, ["push", remote, refspec]).status === 0,
      output: "",
    })),
  deleteLocalBranch: (cwd, branch) => Effect.sync(() => void git(cwd, ["branch", "-D", branch])),
  deleteRemoteBranch: () => Effect.void,
});

interface DrainFixture {
  readonly fixture: RepoFixture;
  readonly mainIntegration: string;
  readonly siblingIntegration: string;
  readonly snapshot: () => MergeQueueSnapshot;
  readonly completions: Array<Parameters<MergeQueueStoreShape["complete"]>[0]>;
  readonly events: Array<unknown>;
  readonly fixes: Array<{ readonly title: string; readonly description: string }>;
  readonly ports: (gate?: MergeQueuePorts["gate"]) => MergeQueuePorts;
}

const entry = (sequence: number): MergeQueueEntry => ({
  sequence,
  childId: "child-1",
  branch: CHILD_BRANCH,
  status: "queued",
  reason: null,
  fixIssueId: null,
});

/**
 * A run-shaped merge state over the two temp repos: integration worktrees at
 * the server paths (`<run>/integration` plus the mirrored sibling), the child
 * branch carrying `commitChild` effects in each repo it touches.
 */
const makeDrainFixture = (input: {
  readonly commitChild: (fixture: RepoFixture) => void;
  readonly siblingLastAcceptedHead?: (fixture: RepoFixture) => string;
}): DrainFixture => {
  const fixture = makeRepos();
  input.commitChild(fixture);
  const runDirectory = NodePath.join(fixture.root, "epic-run-1");
  const mainIntegration = NodePath.join(runDirectory, "integration");
  const siblingIntegration = mirrorPath(runDirectory, "integration", "../sibling");
  git(fixture.main, ["worktree", "add", mainIntegration, "-b", INTEGRATION_BRANCH, "main"]);
  git(fixture.sibling, ["worktree", "add", siblingIntegration, "-b", INTEGRATION_BRANCH, "main"]);

  let snapshot: MergeQueueSnapshot = {
    runId: "run-1",
    lastAcceptedHead: head(fixture.main),
    repositoryPath: fixture.main,
    baseBranch: "main",
    integrationBranch: INTEGRATION_BRANCH,
    integrationWorktreePath: mainIntegration,
    siblings: [
      {
        repositoryPath: fixture.sibling,
        baseBranch: "main",
        integrationWorktreePath: siblingIntegration,
        lastAcceptedHead: input.siblingLastAcceptedHead?.(fixture) ?? head(fixture.sibling),
      },
    ],
    entries: [entry(0)],
  };
  const completions: DrainFixture["completions"] = [];
  const events: Array<unknown> = [];
  const fixes: DrainFixture["fixes"] = [];
  const children: BacklogIssue[] = [];

  const store: MergeQueueStoreShape = {
    read: () => Effect.succeed(snapshot),
    beginDrain: () =>
      Effect.sync(() => {
        snapshot = {
          ...snapshot,
          entries: snapshot.entries.map((item) => ({ ...item, status: "draining" as const })),
        };
        return snapshot.entries;
      }),
    enqueue: () => Effect.void,
    restoreTail: ({ fromSequence }) =>
      Effect.sync(() => {
        snapshot = {
          ...snapshot,
          entries: snapshot.entries.map((item) =>
            item.sequence >= fromSequence && item.status === "draining"
              ? { ...item, status: "queued" as const }
              : item,
          ),
        };
      }),
    beginPark: ({ sequence, reason }) =>
      Effect.sync(() => {
        snapshot = {
          ...snapshot,
          entries: snapshot.entries.map((item) =>
            item.sequence === sequence
              ? { ...item, status: "parked" as const, reason, fixIssueId: null }
              : item,
          ),
        };
      }),
    finalizePark: ({ sequence, fixIssueId }) =>
      Effect.sync(() => {
        snapshot = {
          ...snapshot,
          entries: snapshot.entries.map((item) =>
            item.sequence === sequence ? { ...item, fixIssueId } : item,
          ),
        };
      }),
    complete: (complete) =>
      Effect.sync(() => {
        completions.push(complete);
        snapshot = {
          ...snapshot,
          lastAcceptedHead: complete.lastAcceptedHead,
          siblings: snapshot.siblings.map((sibling) => ({
            ...sibling,
            lastAcceptedHead:
              complete.siblingHeads?.find((head) => head.repositoryPath === sibling.repositoryPath)
                ?.lastAcceptedHead ?? sibling.lastAcceptedHead,
          })),
          entries: snapshot.entries.filter((item) => item.sequence !== complete.sequence),
        };
      }),
    drop: ({ sequence }) =>
      Effect.sync(() => {
        snapshot = {
          ...snapshot,
          entries: snapshot.entries.filter((item) => item.sequence !== sequence),
        };
      }),
    parkedOriginalChild: () => Effect.succeed(Option.none()),
  };

  return {
    fixture,
    mainIntegration,
    siblingIntegration,
    snapshot: () => snapshot,
    completions,
    events,
    fixes,
    ports: (gate) => ({
      store,
      git: makeRealMergeGit(),
      slot: {
        tryAcquire: (holder) => Effect.succeed(Option.some({ holder })),
        release: () => Effect.void,
      },
      gate: gate ?? {
        run: () => Effect.succeed({ passed: true, repositoryPaths: [], output: "" }),
      },
      backlog: {
        listChildren: () => Effect.succeed(children),
        createChild: ({ title, description }) =>
          Effect.sync(() => {
            fixes.push({ title, description });
            const created: BacklogIssue = {
              id: `fix-${String(children.length + 1)}`,
              title,
              status: "open",
              priority: 1,
              issueType: "task",
              parentId: "epic-1",
              description,
              labels: [],
              commentCount: 0,
            };
            children.push(created);
            return created;
          }),
        writeNotes: () => Effect.void,
      },
      events: { emit: (event) => Effect.sync(() => void events.push(event)) },
      fold: { run: () => Effect.void },
    }),
  };
};

const drain = (fixture: DrainFixture, gate?: MergeQueuePorts["gate"]) =>
  drainMergeQueue(
    {
      runId: "run-1",
      epicId: "epic-1",
      holder: "cook-epic-run-1",
      gateCommand: "gate",
      pushEnabled: false,
      verified: true,
      maxGateOutputBytes: 1024,
    },
    fixture.ports(gate),
  );

/** Commit on the child branch in one repo via a scratch worktree. */
const commitOnChildBranch = (fixture: RepoFixture, repo: "main" | "sibling", file: string) => {
  const repositoryPath = fixture[repo];
  const worktree = NodePath.join(fixture.root, "work", repo);
  git(repositoryPath, ["worktree", "add", worktree, "-b", CHILD_BRANCH, "main"]);
  commitFile(worktree, file, `${file} contents\n`, `child work in ${repo}`);
  git(repositoryPath, ["worktree", "remove", "--force", worktree]);
};

describe("sibling layouts over real git repositories", () => {
  it.effect("mirrors the sibling worktree so `../sibling` resolves from the main worktree", () =>
    withFixture((fixture) =>
      Effect.sync(() => {
        const { layout, mainWorktree, siblingWorktree } = provisionLayout(
          fixture,
          "child-1",
          CHILD_BRANCH,
        );
        expect(siblingWorktree).toBe(NodePath.join(layout, "sibling"));
        // The acceptance invariant: the real relative reference resolves.
        expect(NodeFS.realpathSync(NodePath.join(mainWorktree, "..", "sibling"))).toBe(
          NodeFS.realpathSync(siblingWorktree),
        );
        expect(git(fixture.sibling, ["worktree", "list", "--porcelain"])).toContain(
          `worktree ${siblingWorktree}`,
        );
      }),
    ),
  );

  it.effect("cleanup removes the whole layout as one unit", () =>
    withFixture((fixture) =>
      Effect.sync(() => {
        const { layout, mainWorktree, siblingWorktree } = provisionLayout(
          fixture,
          "child-1",
          CHILD_BRANCH,
        );
        // The release sequence of `makeServerPoolWorkspace.release`
        // (`skills/cook-epic/run-legacy.sh:2309-2336`): siblings, main, dir.
        git(fixture.sibling, ["worktree", "remove", "--force", siblingWorktree]);
        git(fixture.main, ["worktree", "remove", "--force", mainWorktree]);
        NodeFS.rmSync(layout, { recursive: true, force: true });

        expect(git(fixture.main, ["worktree", "list", "--porcelain"])).not.toContain(mainWorktree);
        expect(git(fixture.sibling, ["worktree", "list", "--porcelain"])).not.toContain(
          siblingWorktree,
        );
        expect(NodeFS.existsSync(layout)).toBe(false);
        // Branches survive for retries.
        expect(gitResult(fixture.main, ["rev-parse", "--verify", CHILD_BRANCH]).status).toBe(0);
        expect(gitResult(fixture.sibling, ["rev-parse", "--verify", CHILD_BRANCH]).status).toBe(0);
      }),
    ),
  );
});

describe("drainMergeQueue over real git repositories", () => {
  it.effect("lands a branch with commits in both repos in both", () =>
    withFixture(() =>
      Effect.gen(function* () {
        const drainFixture = makeDrainFixture({
          commitChild: (fixture) => {
            commitOnChildBranch(fixture, "main", "feature.txt");
            commitOnChildBranch(fixture, "sibling", "sibling-feature.txt");
          },
        });
        const mainBefore = head(drainFixture.fixture.main);
        const siblingBefore = head(drainFixture.fixture.sibling);

        expect(yield* drain(drainFixture)).toEqual({ _tag: "drained", merged: 1, parked: 0 });

        // Both bases fast-forwarded to their trial merges.
        const mainAfter = head(drainFixture.fixture.main);
        const siblingAfter = head(drainFixture.fixture.sibling);
        expect(mainAfter).not.toBe(mainBefore);
        expect(siblingAfter).not.toBe(siblingBefore);
        expect(git(drainFixture.fixture.main, ["log", "-1", "--format=%s"])).toBe(
          `cook-epic: merge ${CHILD_BRANCH} (child-1)`,
        );
        expect(git(drainFixture.fixture.sibling, ["log", "-1", "--format=%s"])).toBe(
          `cook-epic: merge ${CHILD_BRANCH} (child-1)`,
        );
        // The child work is reachable from both bases.
        expect(
          NodeFS.readFileSync(NodePath.join(drainFixture.fixture.main, "feature.txt"), "utf8"),
        ).toBe("feature.txt contents\n");
        expect(
          NodeFS.readFileSync(
            NodePath.join(drainFixture.fixture.sibling, "sibling-feature.txt"),
            "utf8",
          ),
        ).toBe("sibling-feature.txt contents\n");
        expect(drainFixture.events).toEqual([
          {
            event: "merged",
            child: "child-1",
            branch: CHILD_BRANCH,
            commit: mainAfter.slice(0, 12),
            landing: "gated, landed locally",
            repositories: [
              { repo: drainFixture.fixture.main, commits: 1, head: mainAfter },
              { repo: drainFixture.fixture.sibling, commits: 1, head: siblingAfter },
            ],
          },
        ]);
        expect(drainFixture.completions).toEqual([
          {
            runId: "run-1",
            sequence: 0,
            lastAcceptedHead: mainAfter,
            siblingHeads: [
              { repositoryPath: drainFixture.fixture.sibling, lastAcceptedHead: siblingAfter },
            ],
          },
        ]);
        // The merged branch is deleted in every repo.
        expect(
          gitResult(drainFixture.fixture.main, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${CHILD_BRANCH}`,
          ]).status,
        ).not.toBe(0);
        expect(
          gitResult(drainFixture.fixture.sibling, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${CHILD_BRANCH}`,
          ]).status,
        ).not.toBe(0);
      }),
    ),
  );

  it.effect("parks the whole set behind one Merge-fix child when the sibling conflicts", () =>
    withFixture(() =>
      Effect.gen(function* () {
        const drainFixture = makeDrainFixture({
          commitChild: (fixture) => {
            commitOnChildBranch(fixture, "main", "feature.txt");
            // The sibling branch and the sibling base race on the same file:
            // branch from the initial commit, then move the base.
            commitOnChildBranch(fixture, "sibling", "shared.txt");
            NodeFS.writeFileSync(NodePath.join(fixture.sibling, "shared.txt"), "base moved\n");
            git(fixture.sibling, ["add", "shared.txt"]);
            git(fixture.sibling, ["commit", "-q", "-m", "base moved"]);
          },
        });
        const mainBefore = head(drainFixture.fixture.main);
        const siblingBefore = head(drainFixture.fixture.sibling);

        expect(yield* drain(drainFixture)).toEqual({ _tag: "drained", merged: 0, parked: 1 });

        // Both bases are untouched; the set is parked behind one fix child.
        expect(head(drainFixture.fixture.main)).toBe(mainBefore);
        expect(head(drainFixture.fixture.sibling)).toBe(siblingBefore);
        expect(drainFixture.fixes).toHaveLength(1);
        expect(drainFixture.fixes[0]?.title).toBe(`Merge fix: land ${CHILD_BRANCH} (conflict)`);
        expect(drainFixture.fixes[0]?.description).toContain("lands all-or-nothing");
        expect(drainFixture.fixes[0]?.description).toContain(
          `- this repository (\`${drainFixture.fixture.main}\`, base \`main\`)`,
        );
        expect(drainFixture.fixes[0]?.description).toContain(
          `- sibling \`${drainFixture.fixture.sibling}\` (base \`main\`)`,
        );
        expect(drainFixture.snapshot().entries[0]).toMatchObject({
          status: "parked",
          reason: "conflict",
          fixIssueId: "fix-1",
        });
        // The conflicted sibling trial merge was aborted.
        expect(
          gitResult(drainFixture.siblingIntegration, ["rev-parse", "--verify", "-q", "MERGE_HEAD"])
            .status,
        ).not.toBe(0);
      }),
    ),
  );

  it.effect("stops fatally with the tail restored when the sibling cannot fast-forward", () =>
    withFixture(() =>
      Effect.gen(function* () {
        const drainFixture = makeDrainFixture({
          commitChild: (fixture) => {
            commitOnChildBranch(fixture, "main", "feature.txt");
            commitOnChildBranch(fixture, "sibling", "sibling-feature.txt");
          },
        });
        const siblingBefore = head(drainFixture.fixture.sibling);
        // The sibling base moves mid-drain, after the trial merge but before
        // the landing fast-forward.
        const gate: MergeQueuePorts["gate"] = {
          run: () =>
            Effect.sync(() => {
              commitFile(drainFixture.fixture.sibling, "external.txt", "raced\n", "external move");
              return { passed: true, repositoryPaths: [], output: "" };
            }),
        };

        const result = yield* drain(drainFixture, gate);

        expect(result).toMatchObject({
          _tag: "fatal",
          detail: `sibling ${drainFixture.fixture.sibling} branch main moved externally; cannot fast-forward — operator must reconcile`,
          queueLength: 1,
        });
        expect(drainFixture.snapshot().entries.map((item) => item.status)).toEqual(["queued"]);
        // The only sibling move is the injected external one.
        expect(head(drainFixture.fixture.sibling)).not.toBe(siblingBefore);
        expect(git(drainFixture.fixture.sibling, ["log", "-1", "--format=%s"])).toBe(
          "external move",
        );
      }),
    ),
  );

  it.effect("aborts the pass when a sibling moved externally before the drain", () =>
    withFixture(() =>
      Effect.gen(function* () {
        let staleHead = "";
        const drainFixture = makeDrainFixture({
          commitChild: (fixture) => {
            staleHead = head(fixture.sibling);
            commitOnChildBranch(fixture, "sibling", "sibling-feature.txt");
            // External movement after the head was recorded.
            commitFile(fixture.sibling, "external.txt", "raced\n", "external move");
          },
          siblingLastAcceptedHead: () => staleHead,
        });

        const result = yield* drain(drainFixture);

        expect(result).toMatchObject({
          _tag: "fatal",
          detail: `sibling ${drainFixture.fixture.sibling} branch main moved externally; cannot trial-merge — operator must reconcile`,
          queueLength: 1,
        });
        expect(drainFixture.snapshot().entries.map((item) => item.status)).toEqual(["queued"]);
        // Nothing trial-merged: the integration worktree is untouched.
        expect(head(drainFixture.siblingIntegration)).toBe(head(drainFixture.fixture.sibling));
      }),
    ),
  );
});

import { describe, expect, it } from "vite-plus/test";

import {
  LAYOUT_PROBE_ROOT,
  mirrorPath,
  normalizeAbsolutePath,
  siblingRuleLayout,
  siblingRuleSequential,
  validateMirrorSet,
  type SiblingRef,
} from "./siblings.ts";

describe("normalizeAbsolutePath", () => {
  const cases: ReadonlyArray<{ readonly input: string; readonly expected: string }> = [
    { input: "/", expected: "/" },
    { input: "/a/b/c", expected: "/a/b/c" },
    { input: "/a//b///c", expected: "/a/b/c" },
    { input: "/a/./b/./c", expected: "/a/b/c" },
    { input: "/a/b/../c", expected: "/a/c" },
    { input: "/a/b/../../c", expected: "/c" },
    { input: "/a/../../..", expected: "/" },
    { input: "/..", expected: "/" },
    { input: "/a/b/", expected: "/a/b" },
    { input: "/a/b/.", expected: "/a/b" },
    { input: "/probe/mainrepo/../sibling", expected: "/probe/sibling" },
    { input: "/probe/mainrepo/../../escape", expected: "/escape" },
  ];

  for (const { input, expected } of cases) {
    it(`normalizes ${input} to ${expected}`, () => {
      expect(normalizeAbsolutePath(input)).toBe(expected);
    });
  }
});

describe("mirrorPath", () => {
  it("mirrors a sibling beside the repo into the worker layout dir", () => {
    expect(mirrorPath("/layouts/child-1", "mainrepo", "../sibling")).toBe(
      "/layouts/child-1/sibling",
    );
  });

  it("keeps dot segments out of the mirrored path", () => {
    expect(mirrorPath("/layouts/child-1", "mainrepo", "./.././sibling")).toBe(
      "/layouts/child-1/sibling",
    );
  });

  it("resolves .. chains lexically without touching the filesystem", () => {
    expect(mirrorPath("/layouts/child-1", "mainrepo", "../../escape")).toBe("/layouts/escape");
  });

  it("collapses duplicate slashes and trailing slashes in the layout root", () => {
    expect(mirrorPath("/layouts//child-1/", "mainrepo", "../sibling")).toBe(
      "/layouts/child-1/sibling",
    );
  });
});

// Reproduces the probe-root accept/reject cases of
// skills/cook-epic/run-legacy.sh:255-271 exactly: the main repo sits at
// <probe>/<repoBasename>, siblings mirror to <probe>/<repoBasename>/<rel>.
describe("validateMirrorSet", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly rels: ReadonlyArray<string>;
    readonly accepted: ReadonlyArray<{ readonly rel: string; readonly mirrored: string }>;
    readonly rejected: ReadonlyArray<{
      readonly rel: string;
      readonly mirrored: string;
      readonly reason: string;
      readonly conflictsWith?: string;
    }>;
  }> = [
    {
      name: "accepts a sibling beside the repo",
      rels: ["../sibling"],
      accepted: [{ rel: "../sibling", mirrored: `${LAYOUT_PROBE_ROOT}/sibling` }],
      rejected: [],
    },
    {
      name: "rejects a sibling one level up beside the repo's parent",
      rels: ["../../sibling"],
      accepted: [],
      rejected: [{ rel: "../../sibling", mirrored: "/sibling", reason: "escapes-layout-root" }],
    },
    {
      name: "accepts several siblings at distinct mirrored positions",
      rels: ["../sibling-a", "../sibling-b/nested"],
      accepted: [
        { rel: "../sibling-a", mirrored: `${LAYOUT_PROBE_ROOT}/sibling-a` },
        { rel: "../sibling-b/nested", mirrored: `${LAYOUT_PROBE_ROOT}/sibling-b/nested` },
      ],
      rejected: [],
    },
    {
      name: "rejects a sibling nested inside the main repo",
      rels: ["packages/sibling"],
      accepted: [],
      rejected: [
        {
          rel: "packages/sibling",
          mirrored: `${LAYOUT_PROBE_ROOT}/mainrepo/packages/sibling`,
          reason: "nested-in-main-repo",
        },
      ],
    },
    {
      name: "rejects a sibling equal to the main repo",
      rels: ["."],
      accepted: [],
      rejected: [
        { rel: ".", mirrored: `${LAYOUT_PROBE_ROOT}/mainrepo`, reason: "nested-in-main-repo" },
      ],
    },
    {
      name: "rejects a sibling equal to the main repo through a .. chain",
      rels: ["../mainrepo"],
      accepted: [],
      rejected: [
        {
          rel: "../mainrepo",
          mirrored: `${LAYOUT_PROBE_ROOT}/mainrepo`,
          reason: "nested-in-main-repo",
        },
      ],
    },
    {
      name: "rejects a sibling escaping above the layout root",
      rels: ["../../../escape"],
      accepted: [],
      rejected: [{ rel: "../../../escape", mirrored: "/escape", reason: "escapes-layout-root" }],
    },
    {
      name: "rejects a sibling mirroring onto the probe root itself",
      rels: [".."],
      accepted: [],
      rejected: [{ rel: "..", mirrored: LAYOUT_PROBE_ROOT, reason: "escapes-layout-root" }],
    },
    {
      name: "rejects two siblings mirroring to the same path",
      rels: ["../sibling", "../other/../sibling"],
      accepted: [{ rel: "../sibling", mirrored: `${LAYOUT_PROBE_ROOT}/sibling` }],
      rejected: [
        {
          rel: "../other/../sibling",
          mirrored: `${LAYOUT_PROBE_ROOT}/sibling`,
          reason: "duplicate-mirror",
          conflictsWith: "../sibling",
        },
      ],
    },
    {
      name: "keeps validating after a reject",
      rels: ["packages/inner", "../sibling"],
      accepted: [{ rel: "../sibling", mirrored: `${LAYOUT_PROBE_ROOT}/sibling` }],
      rejected: [
        {
          rel: "packages/inner",
          mirrored: `${LAYOUT_PROBE_ROOT}/mainrepo/packages/inner`,
          reason: "nested-in-main-repo",
        },
      ],
    },
  ];

  for (const { name, rels, accepted, rejected } of cases) {
    it(name, () => {
      const result = validateMirrorSet("mainrepo", rels);
      expect(result.accepted).toEqual(accepted);
      expect(result.rejected).toEqual(rejected);
    });
  }
});

const sibling = (overrides: Partial<SiblingRef> = {}): SiblingRef => ({
  canonicalPath: "/work/proga-api",
  baseBranch: "main",
  relativePath: "../proga-api",
  ...overrides,
});

describe("siblingRuleSequential", () => {
  it("names the real checkouts and forbids pushing", () => {
    const rule = siblingRuleSequential({
      siblings: [
        sibling(),
        sibling({ canonicalPath: "/work/proga-web", relativePath: "../proga-web" }),
      ],
    });
    expect(rule).toBe(
      "This child may span sibling repositories: /work/proga-api /work/proga-web (relative to the project root). You may read, write, build, and commit in them — commit on their current branch, never push; the coordinator pushes whatever moved after the gate. Say which repos gained commits in your close-out note.",
    );
  });
});

describe("siblingRuleLayout", () => {
  it("names the layout, the mirrored worktrees, and the real checkouts", () => {
    const rule = siblingRuleLayout({
      layoutRoot: "/run/layouts",
      layout: "/run/layouts/child-1",
      repoBasename: "t3code",
      branch: "epic/child-1",
      siblings: [sibling()],
    });
    expect(rule).toContain("Your sandbox is the whole layout `/run/layouts/child-1`");
    expect(rule).toContain("`/run/layouts/child-1/proga-api` (mirror of `../proga-api`)");
    expect(rule).toContain("relative references like `../proga-api` resolve");
    expect(rule).toContain("on branch `epic/child-1`");
    expect(rule).toContain("Never touch the real checkouts (`/work/proga-api`)");
    expect(rule).toContain("any other layout under `/run/layouts`");
    expect(rule).toContain("Say which repos gained commits in your close-out note.");
  });
});

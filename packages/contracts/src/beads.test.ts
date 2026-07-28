import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EpicRunPreflightError, EpicRunPreflightInput, EpicRunPreflightResult } from "./beads.ts";
import { WS_METHODS, WsEpicRunPreflightRpc } from "./rpc.ts";

const encodeInput = Schema.encodeSync(EpicRunPreflightInput);
const decodeInput = Schema.decodeUnknownSync(EpicRunPreflightInput);
const encodeResult = Schema.encodeSync(EpicRunPreflightResult);
const decodeResult = Schema.decodeUnknownSync(EpicRunPreflightResult);
const decodeError = Schema.decodeUnknownSync(EpicRunPreflightError);

describe("EpicRunPreflightInput", () => {
  it("round-trips a typed preflight request", () => {
    const input = {
      workspaceRoot: "/repo",
      epicId: "t3code-vst",
      mode: "parallel" as const,
    };

    const encoded = encodeInput(input);

    expect(decodeInput(encoded)).toEqual(input);
  });
});

describe("EpicRunPreflightResult", () => {
  it("round-trips blockers and warnings with their reason-specific details", () => {
    const result = {
      ok: false,
      blockers: [
        { _tag: "dirty_tree" as const, paths: ["src/changed.ts"] },
        {
          _tag: "run_in_progress" as const,
          owner: "cook-epic",
          runDir: "/repo/.worktrees/cook-epic-123",
          host: "devbox",
          pid: 1234,
        },
      ],
      warnings: [
        { _tag: "stale_claims" as const, childIds: ["t3code-vst.1"] },
        { _tag: "nothing_ready" as const, epicId: "t3code-vst" },
      ],
    };

    const encoded = encodeResult(result);

    expect(decodeResult(encoded)).toEqual(result);
  });

  it("rejects malformed reason-specific details", () => {
    expect(() =>
      decodeResult({
        ok: false,
        blockers: [{ _tag: "run_in_progress", owner: "cook-epic" }],
        warnings: [],
      }),
    ).toThrow();
  });
});

describe("WsEpicRunPreflightRpc", () => {
  it("registers the public method and typed error schema", () => {
    expect(WS_METHODS.epicRunPreflight).toBe("epicRunPreflight");
    expect(WsEpicRunPreflightRpc).toBeDefined();

    const error = new EpicRunPreflightError({ message: "bd failed" });
    expect(decodeError(error)).toEqual(error);
  });
});

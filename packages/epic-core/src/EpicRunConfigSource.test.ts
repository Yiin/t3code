// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { EpicRunConfigSource, layer } from "./EpicRunConfigSource.ts";

const withRepo = <A, E>(use: (root: string) => Effect.Effect<A, E>): Effect.Effect<A, E, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "epic-config-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      return yield* use(root);
    }),
  );

const read = (repoRoot: string) =>
  Effect.flatMap(EpicRunConfigSource, (source) => source.read({ repoRoot })).pipe(
    Effect.provide(layer.pipe(Layer.provide(NodeServices.layer))),
  );

const writeConfig = (root: string, value: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.join(root, ".t3code"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, ".t3code", "epic-run.json"), value);
  });

describe("EpicRunConfigSource", () => {
  it.effect("returns absent when the exact file is missing", () =>
    withRepo((root) =>
      Effect.map(read(root), (result) => expect(result).toEqual({ _tag: "absent" })),
    ),
  );

  it.effect("preserves sparse data and returns a fully defaulted config", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        yield* writeConfig(root, '{"parallel":{"workers":2},"gate":{"command":"vp check"}}');
        const result = yield* read(root);
        expect(result._tag).toBe("loaded");
        if (result._tag !== "loaded") return;
        expect(result.override).toEqual({
          parallel: { workers: 2 },
          gate: { command: "vp check" },
        });
        expect(result.config.parallel).toEqual({ siblings: [], workers: 2 });
        expect(result.config.limits.maxIterations).toBe(50);
        expect(result.presentKeys).toEqual(["gate.command", "parallel.workers"]);
        expect(result.unknownKeys).toEqual([]);
      }),
    ),
  );

  it.effect("returns redacted diagnostics for syntax and schema errors", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        yield* writeConfig(root, '{"parallel":{"workers":-739-secret}}');
        const syntax = yield* read(root);
        expect(syntax._tag).toBe("invalid");
        if (syntax._tag === "invalid") {
          expect(syntax.diagnostics.join(" ")).not.toContain("739-secret");
        }
        yield* writeConfig(root, '{"parallel":{"workers":-739}}');
        const schema = yield* read(root);
        expect(schema._tag).toBe("invalid");
        if (schema._tag === "invalid") {
          expect(schema.diagnostics.join(" ")).toContain("parallel");
          expect(schema.diagnostics.join(" ")).not.toContain("-739");
        }
      }),
    ),
  );

  it.effect("reports nested unknown keys without rejecting the file", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        yield* writeConfig(root, '{"parallel":{"workers":2,"futureWorkers":8}}');
        const result = yield* read(root);
        expect(result._tag).toBe("loaded");
        if (result._tag === "loaded") {
          expect(result.unknownKeys).toEqual(["parallel.futureWorkers"]);
        }
      }),
    ),
  );

  it.effect("reports unknown keys inside object-valued config leaves", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        yield* writeConfig(
          root,
          '{"provider":{"modelSelection":{"instanceId":"codex","model":"gpt-5","future":true}}}',
        );
        const result = yield* read(root);
        expect(result._tag).toBe("loaded");
        if (result._tag === "loaded") {
          expect(result.presentKeys).toEqual(["provider.modelSelection"]);
          expect(result.unknownKeys).toEqual(["provider.modelSelection.future"]);
        }
      }),
    ),
  );

  it.effect("ignores a parent config file", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        const child = NodePath.join(root, "child");
        yield* writeConfig(root, '{"parallel":{"workers":2}}');
        yield* Effect.promise(() => NodeFSP.mkdir(child));
        expect(yield* read(child)).toEqual({ _tag: "absent" });
      }),
    ),
  );

  it.effect("rejects JSONC comments and trailing commas", () =>
    withRepo((root) =>
      Effect.gen(function* () {
        yield* writeConfig(root, '{"parallel":{"workers":2,} // comment\n}');
        expect((yield* read(root))._tag).toBe("invalid");
      }),
    ),
  );
});

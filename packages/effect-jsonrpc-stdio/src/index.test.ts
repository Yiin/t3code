import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { schemaIssueDiagnostics } from "./errors.ts";
import { JsonRpcId, encodeJsonl } from "./jsonrpc.ts";
import { makeInMemoryStdio } from "./stdio.ts";
import { makeTerminationLatch, runOnce } from "./protocol.ts";

const decodeNestedNumber = Schema.decodeUnknownEffect(
  Schema.Struct({ user: Schema.Struct({ id: Schema.Number }) }),
);
const isJsonRpcId = Schema.is(JsonRpcId);

it.effect("diagnoses nested schema issues", () =>
  Effect.gen(function* () {
    const issue = yield* decodeNestedNumber({ user: { id: "x" } }).pipe(Effect.flip);
    const diagnostics = schemaIssueDiagnostics(issue.issue);
    assert.equal(diagnostics.issueCount, 5);
    assert.include(diagnostics.issueKinds, "Pointer");
    assert.equal(diagnostics.maximumPathDepth, 2);
  }),
);

it.effect("provides JSON-RPC ids, newline framing, and in-memory stdio", () =>
  Effect.gen(function* () {
    assert.isTrue(isJsonRpcId(1));
    assert.equal(
      yield* encodeJsonl(Schema.Struct({ ok: Schema.Boolean }), { ok: true }),
      '{"ok":true}\n',
    );
    const memory = yield* makeInMemoryStdio();
    assert.isDefined(memory.input);
    assert.isDefined(memory.output);
  }),
);

it.effect("runs termination work once", () =>
  Effect.gen(function* () {
    const latch = yield* makeTerminationLatch();
    const ref = yield* Ref.make(0);
    yield* runOnce(
      latch,
      Ref.update(ref, (value) => value + 1),
    );
    yield* runOnce(
      latch,
      Ref.update(ref, (value) => value + 1),
    );
    assert.equal(yield* Ref.get(ref), 1);
  }),
);

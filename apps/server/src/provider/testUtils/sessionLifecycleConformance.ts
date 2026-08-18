/**
 * sessionLifecycleConformance - one shared spec for `sessionLifecycle.resume`.
 *
 * Every adapter parses the opaque resume cursor in its own private terms, so
 * before this suite each one proved resume to a different depth and nothing
 * stopped an adapter from declaring a capability it did not honour. The suite
 * is table-driven: an adapter test supplies its own fake runtime through a
 * small harness, and the scenarios below hold the adapter to the literal it
 * declares in `ProviderAdapterCapabilities.sessionLifecycle`.
 *
 * Every scenario is gated on that literal. An adapter that declares
 * `"unsupported"` skips the resume rows and instead has to reject a cursor,
 * so "cannot resume" can never be spelled as "silently started fresh".
 *
 * @module sessionLifecycleConformance
 */
import { assert, type Vitest } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";

import { ThreadId } from "@t3tools/contracts";

import type {
  ProviderDriverKind,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";

import type { ProviderAdapterCapabilities } from "../Services/ProviderAdapter.ts";

/**
 * Every adapter fails with its own tagged error union. The scenarios only ever
 * observe *that* a start failed and whether the failure was typed, so the
 * suite asks for the one property they all share rather than for `unknown`.
 */
export interface SessionLifecycleAdapterError {
  readonly _tag: string;
}

/**
 * The slice of `ProviderAdapterShape` the scenarios drive. Structural on
 * purpose: each adapter has its own error type, and the suite only ever
 * observes whether a start failed, never how.
 */
export interface SessionLifecycleAdapterUnderTest {
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, SessionLifecycleAdapterError>;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, SessionLifecycleAdapterError>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, SessionLifecycleAdapterError>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
}

/**
 * What an adapter test hands one scenario. The adapter is already wired to
 * that file's own fake runtime; the hooks translate the scenarios into the
 * adapter's private cursor terms.
 */
export interface SessionLifecycleHarness {
  readonly adapter: SessionLifecycleAdapterUnderTest;

  /**
   * A cursor the fake runtime honours as naming a conversation it already has.
   */
  readonly makeValidCursor: () => unknown;

  /**
   * A cursor from another provider, or this provider's cursor at a schema
   * version the adapter does not read.
   */
  readonly makeForeignCursor: () => unknown;

  /**
   * How many provider-native sessions the fake runtime has created so far. A
   * resume must never move this number.
   */
  readonly readProviderSessionsCreated: () => Effect.Effect<number>;

  /**
   * Extra start fields the adapter needs, such as `cwd` or `modelSelection`.
   */
  readonly startSessionInput?: Omit<
    Partial<ProviderSessionStartInput>,
    "threadId" | "provider" | "resumeCursor"
  >;

  /**
   * Extra turn fields the adapter needs, such as a `modelSelection` it
   * validates before it will accept a prompt.
   */
  readonly sendTurnInput?: Omit<Partial<ProviderSendTurnInput>, "threadId">;

  /**
   * Drive the fake to the point where a freshly started session knows its
   * provider-native id. Adapters that learn the id from a later runtime event
   * (Claude reads it off `system/init`) need this; the rest omit it.
   */
  readonly settleSession?: (threadId: ThreadId) => Effect.Effect<void>;

  /**
   * Provider-native session ids that received a turn, oldest first. The hook
   * owns any waiting the fake runtime needs. Supply it with
   * `resumedProviderSessionId` or not at all.
   */
  readonly readTurnTargets?: () => Effect.Effect<ReadonlyArray<string>>;

  /**
   * The provider-native session id `makeValidCursor()` points at.
   */
  readonly resumedProviderSessionId?: string;

  /**
   * A well-formed cursor naming a conversation the provider does not have.
   * Adapters differ honestly here: some fail fast, some fall back to a fresh
   * session. Both are fine; a defect is not.
   */
  readonly unknownCursor?: {
    readonly make: () => unknown;
    readonly expect: "typed-error" | "fresh-session";
  };
}

export interface SessionLifecycleConformanceInput<R = never> {
  /** Adapter name, used as the describe-row prefix. */
  readonly name: string;
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Build the harness, run one scenario against it, and tear it down. The
   * adapter test owns everything around the body: creating the fake runtime,
   * providing the layer, and any per-test temp files.
   */
  readonly runScenario: (
    body: (harness: SessionLifecycleHarness) => Effect.Effect<void, SessionLifecycleAdapterError>,
  ) => Effect.Effect<void, SessionLifecycleAdapterError, R | Scope.Scope>;

  /**
   * What this file's fake runtime can see. A row whose observation the fake
   * cannot make is not registered at all, so a missing hook shows up as a
   * missing test rather than as a test that quietly asserts nothing.
   */
  readonly observes?: {
    /** The fake records which provider-native session a turn was sent to. */
    readonly turnTargets?: boolean;
    /** The fake can stage a cursor naming a session the provider has lost. */
    readonly unknownCursor?: boolean;
  };
}

const threadIdFor = (name: string, scenario: string): ThreadId =>
  ThreadId.make(`${name}-lifecycle-${scenario}`);

const startInput = (
  input: { readonly provider: ProviderDriverKind },
  harness: SessionLifecycleHarness,
  threadId: ThreadId,
  resumeCursor?: unknown,
): ProviderSessionStartInput => ({
  threadId,
  provider: input.provider,
  runtimeMode: "full-access",
  ...harness.startSessionInput,
  ...(resumeCursor === undefined ? {} : { resumeCursor }),
});

const settle = (harness: SessionLifecycleHarness, threadId: ThreadId): Effect.Effect<void> =>
  harness.settleSession ? harness.settleSession(threadId) : Effect.void;

const readCursor = (harness: SessionLifecycleHarness, threadId: ThreadId): Effect.Effect<unknown> =>
  harness.adapter.listSessions().pipe(
    Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)),
    Effect.map((session) => session?.resumeCursor),
  );

const isNonEmptyCursor = (cursor: unknown): boolean =>
  typeof cursor === "object" && cursor !== null && Object.keys(cursor).length > 0;

/**
 * Add the `sessionLifecycle` conformance rows to an adapter test.
 *
 * Call it inside the file's own `it.layer(...)` block, or inside a `describe`
 * for a file that provides its layer per test, so the `it` passed in is the
 * one that already has the adapter's environment.
 */
export const describeSessionLifecycleConformance = <R>(
  it: Pick<Vitest.MethodsNonLive<R>, "effect">,
  input: SessionLifecycleConformanceInput<R>,
): void => {
  const { name } = input;
  const row = (scenario: string) => `${name} session lifecycle: ${scenario}`;
  const thread = (scenario: string) => threadIdFor(name, scenario);
  const start = (
    harness: SessionLifecycleHarness,
    threadId: ThreadId,
    resumeCursor?: unknown,
  ): Effect.Effect<ProviderSession, SessionLifecycleAdapterError> =>
    harness.adapter.startSession(startInput(input, harness, threadId, resumeCursor));

  if (input.capabilities.sessionLifecycle.resume === "unsupported") {
    // No adapter declares this today. The row exists so the day one does, it
    // has to refuse a cursor rather than quietly ignore it — a silent fresh
    // start would hand the caller a session with none of the history it asked
    // for, and nothing else in the stack would notice.
    it.effect(row("refuses a resume cursor it cannot honour"), () =>
      input.runScenario((harness) =>
        Effect.gen(function* () {
          const threadId = thread("refuses");
          const before = yield* harness.readProviderSessionsCreated();

          const exit = yield* Effect.exit(start(harness, threadId, harness.makeValidCursor()));

          assert.isTrue(
            Exit.isFailure(exit),
            "an adapter declaring resume: unsupported must fail a start that carries a cursor",
          );
          if (Exit.isFailure(exit)) {
            assert.isFalse(Cause.hasDies(exit.cause), "the refusal must be typed, not a defect");
          }
          assert.equal(
            yield* harness.readProviderSessionsCreated(),
            before,
            "a refused start must not leave a provider session behind",
          );
        }),
      ),
    );
    return;
  }

  it.effect(row("returns a resume cursor for a fresh session"), () =>
    input.runScenario((harness) =>
      Effect.gen(function* () {
        const threadId = thread("fresh-cursor");

        yield* start(harness, threadId);
        yield* settle(harness, threadId);

        const cursor = yield* readCursor(harness, threadId);
        assert.isTrue(isNonEmptyCursor(cursor), "a fresh session must expose a persistable cursor");

        yield* harness.adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect(row("resumes a persisted cursor instead of creating a session"), () =>
    input.runScenario((harness) =>
      Effect.gen(function* () {
        const threadId = thread("resume");
        const before = yield* harness.readProviderSessionsCreated();

        const session = yield* start(harness, threadId, harness.makeValidCursor());

        assert.equal(session.threadId, threadId, "a resume keeps the thread it was asked for");
        assert.equal(
          yield* harness.readProviderSessionsCreated(),
          before,
          "a resume must continue the provider session, not create one",
        );

        yield* harness.adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect(row("round-trips the cursor it returns"), () =>
    input.runScenario((harness) =>
      Effect.gen(function* () {
        const threadId = thread("round-trip");

        yield* start(harness, threadId, harness.makeValidCursor());
        yield* settle(harness, threadId);
        const first = yield* readCursor(harness, threadId);
        yield* harness.adapter.stopSession(threadId);

        yield* start(harness, threadId, first);
        yield* settle(harness, threadId);
        const second = yield* readCursor(harness, threadId);

        assert.deepStrictEqual(
          second,
          first,
          "the cursor an adapter hands back must be the cursor it accepts",
        );

        yield* harness.adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect(row("resumes again after stopSession"), () =>
    input.runScenario((harness) =>
      Effect.gen(function* () {
        const threadId = thread("restart");

        yield* start(harness, threadId, harness.makeValidCursor());
        yield* harness.adapter.stopSession(threadId);

        // This is the restart the epic runner survives: the session object is
        // gone, only the persisted cursor is left.
        const before = yield* harness.readProviderSessionsCreated();
        yield* start(harness, threadId, harness.makeValidCursor());

        assert.equal(
          yield* harness.readProviderSessionsCreated(),
          before,
          "a cursor must still resume after the adapter dropped its session",
        );

        yield* harness.adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect(row("starts fresh on a foreign or wrong-version cursor"), () =>
    input.runScenario((harness) =>
      Effect.gen(function* () {
        const threadId = thread("foreign-cursor");
        const before = yield* harness.readProviderSessionsCreated();

        // A cursor the adapter cannot read is not an error. Sessions outlive
        // schema versions and get handed between providers, so the only safe
        // reading is "no cursor at all".
        yield* start(harness, threadId, harness.makeForeignCursor());

        assert.equal(
          yield* harness.readProviderSessionsCreated(),
          before + 1,
          "an unreadable cursor must degrade to a fresh provider session",
        );

        yield* harness.adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect(row("declares the resume mode its behaviour matches"), () =>
    input.runScenario((harness) =>
      Effect.gen(function* () {
        const resumeThreadId = thread("declared-resume");
        const freshThreadId = thread("declared-fresh");

        const beforeResume = yield* harness.readProviderSessionsCreated();
        yield* start(harness, resumeThreadId, harness.makeValidCursor());
        const continued = (yield* harness.readProviderSessionsCreated()) === beforeResume;
        yield* harness.adapter.stopSession(resumeThreadId);

        const beforeFresh = yield* harness.readProviderSessionsCreated();
        yield* start(harness, freshThreadId, harness.makeForeignCursor());
        const created = (yield* harness.readProviderSessionsCreated()) === beforeFresh + 1;
        yield* harness.adapter.stopSession(freshThreadId);

        assert.equal(
          continued && created ? "cursor" : "unsupported",
          input.capabilities.sessionLifecycle.resume,
          "the declared literal must match what the adapter actually does with a cursor",
        );
      }),
    ),
  );

  if (input.observes?.turnTargets) {
    it.effect(row("sends the next turn to the resumed provider session"), () =>
      input.runScenario((harness) =>
        Effect.gen(function* () {
          const readTargets = harness.readTurnTargets;
          const resumedId = harness.resumedProviderSessionId;
          if (!readTargets || resumedId === undefined) {
            return yield* Effect.die(
              new Error(
                "observes.turnTargets is declared but the harness supplied no readTurnTargets/resumedProviderSessionId",
              ),
            );
          }

          const threadId = thread("resumed-turn");
          yield* start(harness, threadId, harness.makeValidCursor());
          yield* harness.adapter.sendTurn({
            threadId,
            input: "session lifecycle conformance turn",
            attachments: [],
            ...harness.sendTurnInput,
          });

          assert.include(
            yield* readTargets(),
            resumedId,
            "a turn after a resume must target the resumed provider session",
          );

          yield* harness.adapter.stopSession(threadId);
        }),
      ),
    );
  }

  if (!input.observes?.unknownCursor) {
    return;
  }

  it.effect(row("answers an unknown cursor without a defect"), () =>
    input.runScenario((harness) =>
      Effect.gen(function* () {
        const unknownCursor = harness.unknownCursor;
        if (!unknownCursor) {
          return yield* Effect.die(
            new Error(
              "observes.unknownCursor is declared but the harness supplied no unknownCursor",
            ),
          );
        }

        const threadId = thread("unknown-cursor");
        const before = yield* harness.readProviderSessionsCreated();

        const exit = yield* Effect.exit(start(harness, threadId, unknownCursor.make()));

        if (Exit.isFailure(exit)) {
          assert.isFalse(
            Cause.hasDies(exit.cause),
            "an unreachable session must surface as a typed adapter error, never a defect",
          );
        }

        if (unknownCursor.expect === "typed-error") {
          assert.isTrue(Exit.isFailure(exit), "this adapter refuses an unknown session id");
          assert.equal(
            yield* harness.readProviderSessionsCreated(),
            before,
            "a refused resume must not leave a provider session behind",
          );
          return;
        }

        assert.isTrue(Exit.isSuccess(exit), "this adapter falls back to a fresh session");
        assert.equal(
          yield* harness.readProviderSessionsCreated(),
          before + 1,
          "the fallback must be a real fresh provider session",
        );
        yield* harness.adapter.stopSession(threadId);
      }),
    ),
  );
};

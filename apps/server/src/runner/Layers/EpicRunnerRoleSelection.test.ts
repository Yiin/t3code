import {
  EpicTierId,
  ProviderDriverKind,
  ProviderInstanceId,
  type EpicRolePolicy,
  type ProviderAccountLimit,
  type ProviderUsageSample,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import type { EpicDispatchRole } from "@t3tools/epic-core/ports/RoleSelection";
import type { ProviderDegradationRecord } from "@t3tools/epic-core/providerDegradation";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { makeEpicRunnerRoleSelection } from "./EpicRunnerRoleSelection.ts";

const instance = (value: string) => ProviderInstanceId.make(value);
const model = "claude-sonnet-5";
const fallback = { instanceId: instance("fallback"), model };

const provider = (id: string): ServerProvider => ({
  instanceId: instance(id),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-14T00:00:00.000Z",
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const policy = (input?: {
  readonly role?: "iteration-worker" | "merge-fix" | "idle-inspection" | "epic-note-fold";
  readonly hops?: ReadonlyArray<{
    readonly id: string;
    readonly skipAboveUtilization?: number;
  }>;
  readonly expandSameDriverAccounts?: boolean;
}): EpicRolePolicy => {
  const tier = EpicTierId.make("tier");
  return {
    tiers: {
      [tier]: {
        expandSameDriverAccounts: input?.expandSameDriverAccounts ?? true,
        hops: (input?.hops ?? [{ id: "one" }, { id: "two" }]).map((hop) => ({
          selection: { instanceId: instance(hop.id), model },
          ...(hop.skipAboveUtilization === undefined
            ? {}
            : { skipAboveUtilization: hop.skipAboveUtilization }),
        })),
      },
    },
    roles: { [input?.role ?? "iteration-worker"]: tier },
    inSessionRoles: {},
  };
};

const usage = (id: string, utilization: number): ProviderUsageSample => ({
  providerInstanceId: instance(id),
  window: "five_hour",
  utilization,
  resetsAt: "2099-01-01T00:00:00.000Z",
  source: "claude.sdk.get_usage",
  observedAt: "2026-08-14T00:00:00.000Z",
});

const limit = (id: string, kind: ProviderAccountLimit["kind"]): ProviderAccountLimit => ({
  providerInstanceId: instance(id),
  driver: ProviderDriverKind.make("claudeAgent"),
  kind,
  detectedAt: "2026-08-14T00:00:00.000Z",
  resetsAt: "2099-01-01T00:00:00.000Z",
  resetsAtEstimated: false,
  source: "claude.sdk.get_usage",
  detail: null,
});

const resolve = (input?: {
  readonly role?: EpicDispatchRole;
  readonly policy?: EpicRolePolicy;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly degradations?: Readonly<Record<string, ProviderDegradationRecord>>;
  readonly usage?: ReadonlyArray<ProviderUsageSample>;
  readonly limits?: ReadonlyArray<ProviderAccountLimit>;
  readonly policyEffect?: Effect.Effect<EpicRolePolicy, PersistenceSqlError>;
  readonly degradationDefect?: boolean;
  readonly degradationDefectFor?: string;
  readonly degradationReads?: string[];
}) =>
  makeEpicRunnerRoleSelection({
    readEpicRolePolicy: input?.policyEffect ?? Effect.succeed(input?.policy ?? policy()),
    inventory: {
      getProviders: Effect.succeed(input?.providers ?? [provider("one"), provider("two")]),
    },
    readProviderDegradation: (id) =>
      Effect.sync(() => input?.degradationReads?.push(id)).pipe(
        Effect.flatMap(() =>
          input?.degradationDefect || input?.degradationDefectFor === id
            ? Effect.die("boom")
            : Effect.succeed(
                input?.degradations?.[id] === undefined
                  ? Option.none()
                  : Option.some(input.degradations[id]),
              ),
        ),
      ),
    readUsageSamples: Effect.succeed(input?.usage ?? []),
    readAccountLimits: Effect.succeed(input?.limits ?? []),
    providerDegradationTtlMs: 3_600_000,
  }).resolve({
    role: input?.role ?? "iteration-worker",
    runId: "run",
    issueId: "child",
    issueTitle: "Child",
    fallbackSelection: fallback,
  });

describe("EpicRunnerRoleSelection", () => {
  it.effect("maps every dispatch role to its policy role", () =>
    Effect.gen(function* () {
      const cases = [
        ["iteration-worker", "iteration-worker"],
        ["merge-fix-child", "merge-fix"],
        ["idle-inspector", "idle-inspection"],
        ["note-fold", "epic-note-fold"],
      ] as const;
      for (const [dispatchRole, policyRole] of cases) {
        const result = yield* resolve({
          role: dispatchRole,
          policy: policy({ role: policyRole, hops: [{ id: policyRole }] }),
          providers: [provider(policyRole)],
        });
        expect(result.selection.instanceId).toBe(policyRole);
        expect(result.tierId).toBe("tier");
      }
    }),
  );

  it.effect("skips degradation, global exhaustion, and live limit rows", () =>
    Effect.gen(function* () {
      const live = {
        failureReason: "provider-error:rate-limit",
        degradedAt: "2026-08-14T00:00:00.000Z",
        resetsAt: "2099-01-01T00:00:00.000Z",
      };
      expect((yield* resolve({ degradations: { one: live } })).selection.instanceId).toBe("two");
      expect((yield* resolve({ usage: [usage("one", 100)] })).selection.instanceId).toBe("two");
      expect((yield* resolve({ limits: [limit("one", "usage-limit")] })).selection.instanceId).toBe(
        "two",
      );
      expect((yield* resolve({ limits: [limit("one", "spend-limit")] })).selection.instanceId).toBe(
        "two",
      );
    }),
  );

  it.effect("loads degradation state for expanded same-driver siblings", () =>
    Effect.gen(function* () {
      const live = {
        failureReason: "provider-error:rate-limit",
        degradedAt: "2026-08-14T00:00:00.000Z",
        resetsAt: "2099-01-01T00:00:00.000Z",
      };
      const result = yield* resolve({
        policy: policy({ hops: [{ id: "one" }] }),
        providers: [provider("one"), provider("two"), provider("three")],
        degradations: { one: live, two: live },
      });

      expect(result.selection.instanceId).toBe("three");
    }),
  );

  it.effect("does not read degradation state for unrelated providers", () =>
    Effect.gen(function* () {
      const reads: string[] = [];
      const result = yield* resolve({
        policy: policy({ hops: [{ id: "one" }], expandSameDriverAccounts: false }),
        providers: [provider("one"), provider("unrelated")],
        degradationDefectFor: "unrelated",
        degradationReads: reads,
      });

      expect(result.selection.instanceId).toBe("one");
      expect(reads).toEqual(["one"]);
    }),
  );

  it.effect("uses strict threshold comparison", () =>
    Effect.gen(function* () {
      const configured = policy({ hops: [{ id: "one", skipAboveUtilization: 80 }, { id: "two" }] });
      expect(
        (yield* resolve({ policy: configured, usage: [usage("one", 80)] })).selection.instanceId,
      ).toBe("one");
      expect(
        (yield* resolve({ policy: configured, usage: [usage("one", 81)] })).selection.instanceId,
      ).toBe("two");
    }),
  );

  it.effect("falls back for missing, empty, blocked, failed, and defective policy reads", () =>
    Effect.gen(function* () {
      const missing: EpicRolePolicy = { tiers: {}, roles: {}, inSessionRoles: {} };
      const empty = policy({ hops: [] });
      const blocked = policy({ hops: [{ id: "one" }], expandSameDriverAccounts: false });
      const liveLimit = limit("one", "usage-limit");
      const failed = Effect.fail(new PersistenceSqlError({ operation: "settings" }));
      const results = [
        yield* resolve({ policy: missing }),
        yield* resolve({ policy: empty }),
        yield* resolve({ policy: blocked, limits: [liveLimit] }),
        yield* resolve({ policyEffect: failed }),
        yield* resolve({ degradationDefect: true }),
      ];
      for (const result of results) {
        expect(result).toEqual({ selection: fallback, tierId: null });
      }
    }),
  );

  it.effect("attributes a tier when it selects the same account as the fallback", () =>
    Effect.gen(function* () {
      const result = yield* resolve({
        policy: policy({ hops: [{ id: "fallback" }] }),
        providers: [provider("fallback")],
      });
      expect(result).toEqual({ selection: fallback, tierId: "tier" });
    }),
  );
});

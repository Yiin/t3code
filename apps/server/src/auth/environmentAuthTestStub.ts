import * as Effect from "effect/Effect";

import type { EnvironmentAuth } from "./EnvironmentAuth.ts";

/**
 * EnvironmentAuth test double that fails loudly on any use. Suites that never
 * exercise auth (for example ProviderService tests without T3_* injection)
 * install this so an accidental call surfaces a clear error instead of a
 * silent `undefined is not a function`.
 */
export function makeUnconfiguredEnvironmentAuth(): EnvironmentAuth["Service"] {
  return new Proxy({} as EnvironmentAuth["Service"], {
    get(_target, property) {
      if (typeof property !== "string") {
        return undefined;
      }
      return () =>
        Effect.die(
          new Error(`EnvironmentAuth not configured in this test harness (called '${property}').`),
        );
    },
  });
}

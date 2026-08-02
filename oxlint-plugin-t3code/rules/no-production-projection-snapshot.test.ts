import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const RULE = "t3code/no-production-projection-snapshot";

const productionFile = createOxlintRuleHarness(RULE, { filename: "http.ts" });
const testFile = createOxlintRuleHarness(RULE, { filename: "fixture.test.ts" });
const integrationHarnessFile = createOxlintRuleHarness(RULE, {
  filename: "Harness.integration.ts",
});

describe(RULE, () => {
  productionFile.invalid(
    "reports a production call to getSnapshot",
    `
      import * as Effect from "effect/Effect";

      import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

      export const handler = Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        return yield* query.getSnapshot();
      });
    `,
    (output) => {
      assert.match(output, /getShellSnapshot/);
      assert.match(output, /getThreadDetailSnapshot/);
      assert.match(output, /getCommandReadModel/);
    },
  );

  productionFile.invalid(
    "reports an optional-chained production call to getSnapshot",
    `
      import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

      export const read = (query?: typeof ProjectionSnapshotQuery.Service) =>
        query?.getSnapshot();
    `,
  );

  productionFile.valid(
    "allows the bounded snapshot reads",
    `
      import * as Effect from "effect/Effect";

      import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

      export const handler = Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        yield* query.getShellSnapshot();
        yield* query.getCommandReadModel();
        return yield* query.getThreadDetailSnapshot("thread-1");
      });
    `,
  );

  productionFile.valid(
    "ignores an unrelated getSnapshot on a file that never imports the service",
    `
      import { useSyncExternalStore } from "react";

      const store = { getSnapshot: () => 1, subscribe: () => () => {} };

      export const useStore = () => useSyncExternalStore(store.subscribe, () => store.getSnapshot());
    `,
  );

  testFile.valid(
    "allows getSnapshot in tests",
    `
      import * as Effect from "effect/Effect";

      import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

      export const readModel = Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        return yield* query.getSnapshot();
      });
    `,
  );

  integrationHarnessFile.valid(
    "allows getSnapshot in the integration harness",
    `
      import * as Effect from "effect/Effect";

      import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";

      export const waitForThread = Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        return yield* query.getSnapshot();
      });
    `,
  );
});

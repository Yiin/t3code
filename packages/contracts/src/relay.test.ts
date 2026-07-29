import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import {
  RelayApi,
  RelayEpicRunActivityPublishRequest,
  RelayPublishedActivityState,
} from "./relay.ts";

const decodePublishedActivityState = Schema.decodeUnknownSync(RelayPublishedActivityState);
const decodeEpicRunPublishRequest = Schema.decodeUnknownSync(RelayEpicRunActivityPublishRequest);

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });

  it("accepts thread and epic-run activity variants and exposes the epic publish route", () => {
    const run = decodePublishedActivityState({
      kind: "epic_run",
      environmentId: "env",
      runId: "run-1",
      epicId: "t3code-vst",
      epicTitle: "First-class epic cooking",
      phase: "running",
      iteration: 2,
      maxIterations: 5,
      childTitle: "Relay notifications",
      updatedAt: "2026-07-29T00:00:00.000Z",
      deepLink: "/epics/env/t3code-vst",
    });
    expect("kind" in run ? run.kind : null).toBe("epic_run");
    expect(decodeEpicRunPublishRequest({ state: null, proof: "jwt" })).toEqual({
      state: null,
      proof: "jwt",
    });

    const document = OpenApi.fromApi(RelayApi);
    expect(
      document.paths["/v1/environments/{environmentId}/epics/{epicId}/agent-activity"],
    ).toBeDefined();
  });
});

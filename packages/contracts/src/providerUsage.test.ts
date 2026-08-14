import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAccountLimit, ProviderAccountLimitSignal } from "./providerUsage.ts";

const decodeProviderAccountLimit = Schema.decodeUnknownSync(ProviderAccountLimit);
const encodeProviderAccountLimit = Schema.encodeSync(ProviderAccountLimit);
const decodeProviderAccountLimitSignal = Schema.decodeUnknownSync(ProviderAccountLimitSignal);

const fullLimit = {
  providerInstanceId: "claude-work",
  driver: "claudeAgent",
  kind: "usage-limit",
  detectedAt: "2026-08-14T00:00:00.000Z",
  resetsAt: "2026-08-14T05:00:00.000Z",
  resetsAtEstimated: true,
  source: "claude.sdk.rate_limit_event",
  detail: "5-hour window reached",
} as const;

describe("ProviderAccountLimit", () => {
  it("round-trips a full limit", () => {
    const decoded = decodeProviderAccountLimit(fullLimit);
    expect(decoded).toEqual(fullLimit);
    expect(encodeProviderAccountLimit(decoded)).toEqual(fullLimit);
  });

  it("accepts a null resetsAt", () => {
    const decoded = decodeProviderAccountLimit({
      ...fullLimit,
      resetsAt: null,
      resetsAtEstimated: false,
    });
    expect(decoded.resetsAt).toBeNull();
  });

  it("rejects an unknown kind", () => {
    expect(() => decodeProviderAccountLimit({ ...fullLimit, kind: "cooldown" })).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() => decodeProviderAccountLimit({ ...fullLimit, source: "kimi.api_error" })).toThrow();
  });
});

describe("ProviderAccountLimitSignal", () => {
  it("decodes without providerInstanceId or driver", () => {
    const { providerInstanceId: _instance, driver: _driver, ...signal } = fullLimit;
    expect(decodeProviderAccountLimitSignal(signal)).toEqual(signal);
  });
});

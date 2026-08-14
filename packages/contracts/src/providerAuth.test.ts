import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAuthRunState } from "./providerAuth.ts";

const decodeState = Schema.decodeUnknownSync(ProviderAuthRunState);

const state = {
  status: "running",
  startedAt: null,
  finishedAt: null,
  message: null,
  output: "",
  verificationUrl: null,
  userCode: null,
} as const;

describe("ProviderAuthRunState", () => {
  it("bounds verification URLs", () => {
    expect(() =>
      decodeState({ ...state, verificationUrl: `https://${"a".repeat(2_040)}` }),
    ).not.toThrow();
    expect(() =>
      decodeState({ ...state, verificationUrl: `https://${"a".repeat(2_041)}` }),
    ).toThrow();
  });

  it("bounds user codes", () => {
    expect(() => decodeState({ ...state, userCode: "a".repeat(128) })).not.toThrow();
    expect(() => decodeState({ ...state, userCode: "a".repeat(129) })).toThrow();
  });
});

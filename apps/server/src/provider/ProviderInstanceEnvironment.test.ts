import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("uses the instance PATH instead of the inherited PATH", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "PATH", value: "/provider/bin", sensitive: false }],
        { PATH: "/base/bin", BASE_ONLY: "preserved" },
      ),
    ).toEqual({
      PATH: "/provider/bin",
      BASE_ONLY: "preserved",
    });
  });

  it("lets every instance variable override its inherited value", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "PATH", value: "/instance/bin", sensitive: false },
          { name: "SHARED", value: "instance", sensitive: false },
          { name: "EMPTY", value: "", sensitive: false },
        ],
        {
          PATH: "/base/bin",
          SHARED: "base",
          EMPTY: "base",
          BASE_ONLY: "preserved",
        },
      ),
    ).toEqual({
      PATH: "/instance/bin",
      SHARED: "instance",
      EMPTY: "",
      BASE_ONLY: "preserved",
    });
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});

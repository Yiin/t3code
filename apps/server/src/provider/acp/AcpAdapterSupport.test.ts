import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  acpPermissionOutcome,
  mapAcpSessionStartError,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("maps a refused resume to a provider adapter resume error", () => {
    const error = mapAcpSessionStartError({
      provider: ProviderDriverKind.make("kimi"),
      threadId: "thread-1" as never,
      method: "session/start",
      resumeSessionId: "session-9",
      error: new EffectAcpErrors.AcpUnsupportedCapabilityError({
        capability: "loadSession",
        method: "session/load",
        detail: "no loadSession",
      }),
    });

    expect(error._tag).toBe("ProviderAdapterResumeError");
    expect(error.message).toContain("session-9");
  });

  it("keeps a start failure that carried no cursor a request error", () => {
    const error = mapAcpSessionStartError({
      provider: ProviderDriverKind.make("kimi"),
      threadId: "thread-1" as never,
      method: "session/start",
      resumeSessionId: undefined,
      error: new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
      }),
    });

    expect(error._tag).toBe("ProviderAdapterRequestError");
  });
});

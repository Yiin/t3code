/**
 * Pins every built-in adapter's declared attachment support to the contracts
 * table clients read (`attachmentCapabilityForDriver`). The two describe the
 * same fact from opposite sides of the wire, so they must never drift.
 */
import {
  attachmentCapabilityForDriver,
  BUILT_IN_PROVIDER_DRIVER_KINDS,
  PRIME_AGENT_DRIVER_KIND,
  ProviderDriverKind,
  UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderAdapterCapabilities } from "../Services/ProviderAdapter.ts";
import { CLAUDE_ADAPTER_CAPABILITIES } from "./ClaudeAdapter.ts";
import { CODEX_ADAPTER_CAPABILITIES } from "./CodexAdapter.ts";
import { CURSOR_ADAPTER_CAPABILITIES } from "./CursorAdapter.ts";
import { GROK_ADAPTER_CAPABILITIES } from "./GrokAdapter.ts";
import { KIMI_ADAPTER_CAPABILITIES } from "./KimiAdapter.ts";
import { OPENCODE_ADAPTER_CAPABILITIES } from "./OpenCodeAdapter.ts";
import { PRIME_ADAPTER_CAPABILITIES } from "./PrimeAdapter.ts";

const BUILT_IN_ADAPTER_CAPABILITIES: ReadonlyArray<
  readonly [ProviderDriverKind, ProviderAdapterCapabilities]
> = [
  [ProviderDriverKind.make("codex"), CODEX_ADAPTER_CAPABILITIES],
  [ProviderDriverKind.make("claudeAgent"), CLAUDE_ADAPTER_CAPABILITIES],
  [ProviderDriverKind.make("cursor"), CURSOR_ADAPTER_CAPABILITIES],
  [ProviderDriverKind.make("grok"), GROK_ADAPTER_CAPABILITIES],
  [ProviderDriverKind.make("kimi"), KIMI_ADAPTER_CAPABILITIES],
  [ProviderDriverKind.make("opencode"), OPENCODE_ADAPTER_CAPABILITIES],
  [PRIME_AGENT_DRIVER_KIND, PRIME_ADAPTER_CAPABILITIES],
];

describe("built-in adapter attachment capabilities", () => {
  it("covers every built-in driver kind", () => {
    expect(new Set(BUILT_IN_ADAPTER_CAPABILITIES.map(([driver]) => driver))).toEqual(
      new Set(BUILT_IN_PROVIDER_DRIVER_KINDS),
    );
  });

  it.each(BUILT_IN_ADAPTER_CAPABILITIES)("%s matches the contracts table", (driver, declared) => {
    expect(declared.attachments).toEqual(attachmentCapabilityForDriver(driver));
    expect(declared.attachments).not.toBe(UNKNOWN_DRIVER_ATTACHMENT_CAPABILITY);
  });
});

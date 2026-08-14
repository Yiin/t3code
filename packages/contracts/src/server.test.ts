import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig, ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const encodeServerProvider = Schema.encodeUnknownSync(ServerProvider);
const decodeServerSlashCommands = Schema.decodeUnknownSync(ServerConfig.fields.serverSlashCommands);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes snapshots that omit per-account usage and limit state", () => {
    const parsed = decodeServerProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect("usage" in parsed).toBe(false);
    expect("limit" in parsed).toBe(false);
  });

  it("round-trips per-account usage and limit state", () => {
    const snapshot = {
      instanceId: "claude_personal",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      usage: [
        {
          providerInstanceId: "claude_personal",
          window: "five_hour",
          utilization: 62,
          resetsAt: "2026-04-10T03:00:00.000Z",
          source: "claude.sdk.get_usage",
          observedAt: "2026-04-10T00:00:00.000Z",
        },
      ],
      limit: {
        providerInstanceId: "claude_personal",
        driver: "claudeAgent",
        kind: "usage-limit",
        detectedAt: "2026-04-10T00:00:00.000Z",
        resetsAt: "2026-04-10T03:00:00.000Z",
        resetsAtEstimated: false,
        source: "claude.sdk.rate_limit_event",
        detail: null,
      },
    };

    const parsed = decodeServerProvider(snapshot);
    expect(parsed.usage).toEqual(snapshot.usage);
    expect(parsed.limit).toEqual(snapshot.limit);
    expect(encodeServerProvider(parsed)).toEqual(snapshot);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });
});

describe("ServerConfig", () => {
  it("defaults workspace slash commands when decoding older snapshots", () => {
    expect(decodeServerSlashCommands(undefined)).toEqual([]);
  });
});

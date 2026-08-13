import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";

import { mapClaudeUsageResponse, readClaudeUsageForProbe } from "./ClaudeProvider.ts";

function usageResponse(
  overrides: Partial<SDKControlGetUsageResponse> = {},
): SDKControlGetUsageResponse {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: "pro",
    rate_limits_available: true,
    rate_limits: {},
    behaviors: null,
    ...overrides,
  } as SDKControlGetUsageResponse;
}

describe("mapClaudeUsageResponse", () => {
  for (const testCase of [
    {
      name: "rate limits are unavailable",
      response: usageResponse({ rate_limits_available: false, rate_limits: null }),
    },
    {
      name: "rate limits are null",
      response: usageResponse({ rate_limits: null }),
    },
  ]) {
    it(`returns no readings when ${testCase.name}`, () => {
      assert.deepEqual(mapClaudeUsageResponse(testCase.response), []);
    });
  }

  it("maps settled windows and overage while dropping OAuth-app and null utilization", () => {
    const response = usageResponse({
      rate_limits: {
        five_hour: { utilization: 10, resets_at: "2026-08-11T05:00:00.000Z" },
        seven_day: { utilization: 20, resets_at: "2026-08-18T00:00:00.000Z" },
        seven_day_opus: { utilization: 30, resets_at: null },
        seven_day_sonnet: { utilization: 40, resets_at: "2026-08-19T00:00:00.000Z" },
        seven_day_oauth_apps: {
          utilization: 50,
          resets_at: "2026-08-20T00:00:00.000Z",
        },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 60,
          utilization: 60,
          currency: "USD",
        },
      },
    });

    assert.deepEqual(mapClaudeUsageResponse(response), [
      {
        window: "five_hour",
        utilization: 10,
        resetsAt: "2026-08-11T05:00:00.000Z",
        source: "claude.sdk.get_usage",
      },
      {
        window: "seven_day",
        utilization: 20,
        resetsAt: "2026-08-18T00:00:00.000Z",
        source: "claude.sdk.get_usage",
      },
      {
        window: "seven_day_opus",
        utilization: 30,
        resetsAt: null,
        source: "claude.sdk.get_usage",
      },
      {
        window: "seven_day_sonnet",
        utilization: 40,
        resetsAt: "2026-08-19T00:00:00.000Z",
        source: "claude.sdk.get_usage",
      },
      {
        window: "overage",
        utilization: 60,
        resetsAt: null,
        source: "claude.sdk.get_usage",
      },
    ]);
  });

  it("drops one null-utilization window without dropping its siblings", () => {
    const response = usageResponse({
      rate_limits: {
        five_hour: { utilization: null, resets_at: "2026-08-11T05:00:00.000Z" },
        seven_day: { utilization: 25, resets_at: null },
        extra_usage: {
          is_enabled: true,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
        },
      },
    });

    assert.deepEqual(mapClaudeUsageResponse(response), [
      {
        window: "seven_day",
        utilization: 25,
        resetsAt: null,
        source: "claude.sdk.get_usage",
      },
    ]);
  });
});

describe("readClaudeUsageForProbe", () => {
  it("returns no readings when the optional SDK method is missing", async () => {
    assert.deepEqual(await readClaudeUsageForProbe({}), []);
  });

  it("returns no readings when the SDK method throws", async () => {
    assert.deepEqual(
      await readClaudeUsageForProbe({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
          throw new Error("usage unavailable");
        },
      }),
      [],
    );
  });

  it("returns no readings when the SDK method times out", async () => {
    assert.deepEqual(
      await readClaudeUsageForProbe(
        {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}),
        },
        1,
      ),
      [],
    );
  });
});

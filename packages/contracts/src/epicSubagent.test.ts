import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EpicSubagentDefinition, EpicSubagentMap } from "./epicSubagent.ts";

const decodeDefinition = Schema.decodeUnknownSync(EpicSubagentDefinition);
const decodeMap = Schema.decodeUnknownSync(EpicSubagentMap);
const encodeDefinition = Schema.encodeSync(EpicSubagentDefinition);

describe("EpicSubagentDefinition", () => {
  it("decodes a minimal definition without a model", () => {
    const decoded = decodeDefinition({
      description: "Plans implementation work",
      prompt: "Create a focused implementation plan.",
    });

    expect(decoded).toEqual({
      description: "Plans implementation work",
      prompt: "Create a focused implementation plan.",
    });
    expect(decoded.model).toBeUndefined();
  });

  it("round-trips a definition with a model and tools", () => {
    const input = {
      description: "Reviews completed work",
      prompt: "Review the implementation and report defects.",
      model: "fable",
      tools: ["Read", "Grep"],
    };
    const decoded = decodeDefinition(input);

    expect(encodeDefinition(decoded)).toEqual(input);
  });

  it("rejects a definition without a prompt", () => {
    expect(() =>
      decodeDefinition({
        description: "Plans implementation work",
      }),
    ).toThrow();
  });

  it("rejects an empty description", () => {
    expect(() =>
      decodeDefinition({
        description: "",
        prompt: "Create a focused implementation plan.",
      }),
    ).toThrow();
  });
});

describe("EpicSubagentMap", () => {
  it("decodes two named definitions and preserves both keys", () => {
    const decoded = decodeMap({
      planner: {
        description: "Plans implementation work",
        prompt: "Create a focused implementation plan.",
      },
      reviewer: {
        description: "Reviews completed work",
        prompt: "Review the implementation and report defects.",
        model: "fable",
      },
    });

    expect(Object.keys(decoded)).toEqual(["planner", "reviewer"]);
  });
});

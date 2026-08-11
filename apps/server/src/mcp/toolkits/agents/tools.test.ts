import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { AgentsToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(AgentsToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("tells the model to do a refused spawn itself, not to reach for a denied tool", () => {
  // The built-in Task and Workflow tools are denied on every session where this
  // tool can spawn, so "fall back to Task" is advice the model cannot follow.
  // t3code-vzb.23 measured what it does instead: retry with a different
  // agent_type, or escape to Workflow.
  const description = AgentsToolkit.tools.spawn_agent.description ?? "";

  expect(description).toMatch(/do that work yourself/);
  expect(description).not.toMatch(/fall back to your built-in/i);
});

it("takes no parent thread parameter, so a model cannot spawn under another thread", () => {
  const schema = Tool.getJsonSchema(AgentsToolkit.tools.spawn_agent) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
    "agent_type",
    "description",
    "model",
    "prompt",
  ]);
  expect([...(schema.required ?? [])].sort()).toEqual(["agent_type", "description", "prompt"]);
});

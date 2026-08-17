import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class GeneratorFormatError extends Schema.TaggedErrorClass<GeneratorFormatError>()(
  "GeneratorFormatError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
export const isGeneratorFormatError = Schema.is(GeneratorFormatError);

export function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}

export function normalizeNullableTypes(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(normalizeNullableTypes);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedObject = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeNullableTypes(child)]),
  ) as Record<string, Schema.Json>;
  const typeValue = normalizedObject.type;
  if (!Array.isArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => typeof entry === "string");
  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");
  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }

  const nextObject: Record<string, Schema.Json> = {};
  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [{ ...nextObject, type: nonNullTypes[0]! }, { type: "null" }],
  };
}

export const formatGeneratedDirectory = Effect.fn("formatGeneratedDirectory")(function* (
  generatedDir: string,
) {
  const spawner = yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner);
  const child = yield* spawner.spawn(ChildProcess.make("vp", ["fmt", generatedDir, "--write"]));
  const code = yield* child.exitCode;
  if (code !== 0) {
    return yield* new GeneratorFormatError({ detail: `vp fmt failed with exit code ${code}` });
  }
});

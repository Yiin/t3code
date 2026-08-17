import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  EPIC_RUN_CONFIG_KEY_PREFIXES,
  EPIC_RUN_CONFIG_LEAF_KEY_SET,
  EpicRunConfig,
  EpicRunConfigOverride,
  type EpicRunConfig as EpicRunConfigValue,
  type EpicRunConfigOverride as EpicRunConfigOverrideValue,
} from "@t3tools/contracts";
import { formatSchemaError } from "@t3tools/shared/schemaJson";

export type EpicRunConfigFileResult =
  | { readonly _tag: "absent" }
  | {
      readonly _tag: "loaded";
      readonly configPath: string;
      readonly override: EpicRunConfigOverrideValue;
      readonly config: EpicRunConfigValue;
      readonly presentKeys: readonly string[];
      readonly unknownKeys: readonly string[];
    }
  | {
      readonly _tag: "invalid";
      readonly configPath: string;
      readonly diagnostics: readonly string[];
    };

export interface EpicRunConfigSourceShape {
  readonly read: (input: {
    readonly repoRoot: string;
  }) => Effect.Effect<EpicRunConfigFileResult, never>;
}

export class EpicRunConfigSource extends Context.Service<
  EpicRunConfigSource,
  EpicRunConfigSourceShape
>()("@t3tools/epic-core/EpicRunConfigSource") {}

const knownObjectLeafKeys: Readonly<Record<string, ReadonlySet<string>>> = {
  "provider.modelSelection": new Set(["provider", "instanceId", "model", "options"]),
};

function inspectKeys(value: unknown): {
  readonly presentKeys: readonly string[];
  readonly unknownKeys: readonly string[];
} {
  const presentKeys: string[] = [];
  const unknownKeys: string[] = [];
  const visit = (current: unknown, prefix: string): void => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return;
    for (const [key, child] of Object.entries(current)) {
      const dottedKey = prefix === "" ? key : `${prefix}.${key}`;
      if (EPIC_RUN_CONFIG_LEAF_KEY_SET.has(dottedKey)) {
        presentKeys.push(dottedKey);
        const knownChildren = knownObjectLeafKeys[dottedKey];
        if (knownChildren !== undefined && typeof child === "object" && child !== null) {
          for (const childKey of Object.keys(child)) {
            if (!knownChildren.has(childKey)) unknownKeys.push(`${dottedKey}.${childKey}`);
          }
        }
      } else if (EPIC_RUN_CONFIG_KEY_PREFIXES.has(dottedKey)) {
        visit(child, dottedKey);
      } else {
        unknownKeys.push(dottedKey);
      }
    }
  };
  visit(value, "");
  return { presentKeys: presentKeys.toSorted(), unknownKeys: unknownKeys.toSorted() };
}

const decodeOverride = Schema.decodeUnknownExit(EpicRunConfigOverride);
const decodeConfig = Schema.decodeUnknownExit(EpicRunConfig);
const decodeJson = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);

function schemaDiagnostic(exit: Exit.Exit<unknown, Schema.SchemaError>): readonly string[] {
  return Exit.isFailure(exit) ? [formatSchemaError(exit.cause)] : [];
}

export const layer = Layer.effect(
  EpicRunConfigSource,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const read: EpicRunConfigSourceShape["read"] = Effect.fn("EpicRunConfigSource.read")(
      function* (input) {
        const configPath = path.join(input.repoRoot, ".t3code", "epic-run.json");
        const exists = yield* fileSystem.exists(configPath).pipe(Effect.exit);
        if (Exit.isFailure(exists)) {
          return { _tag: "invalid", configPath, diagnostics: ["Could not inspect config file."] };
        }
        if (!exists.value) return { _tag: "absent" };

        const readResult = yield* fileSystem.readFileString(configPath).pipe(Effect.exit);
        if (Exit.isFailure(readResult)) {
          return { _tag: "invalid", configPath, diagnostics: ["Could not read config file."] };
        }

        const parsed = decodeJson(readResult.value);
        if (Exit.isFailure(parsed)) {
          return {
            _tag: "invalid",
            configPath,
            diagnostics: [formatSchemaError(parsed.cause)],
          };
        }
        const raw = parsed.value;

        const override = decodeOverride(raw);
        if (Exit.isFailure(override)) {
          return { _tag: "invalid", configPath, diagnostics: schemaDiagnostic(override) };
        }
        const config = decodeConfig(raw);
        if (Exit.isFailure(config)) {
          return { _tag: "invalid", configPath, diagnostics: schemaDiagnostic(config) };
        }
        return {
          _tag: "loaded",
          configPath,
          override: override.value,
          config: config.value,
          ...inspectKeys(raw),
        };
      },
    );

    return EpicRunConfigSource.of({ read });
  }),
);

import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface ManagedAccountHomeInput {
  readonly accountsDir: string;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}

export const managedAccountHomePath = Effect.fn("managedAccountHomePath")(function* (
  input: ManagedAccountHomeInput,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  return path.join(input.accountsDir, input.driverKind, input.instanceId);
});

/**
 * Creates a private home for one provider account. OpenCode stores this path
 * as dataHomePath and creates its own opencode/ directory inside it.
 * Managed account homes are never removed by allocation.
 */
export const ensureManagedAccountHome = Effect.fn("ensureManagedAccountHome")(function* (
  input: ManagedAccountHomeInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = path.resolve(yield* managedAccountHomePath(input));
  yield* fileSystem.makeDirectory(homePath, { recursive: true, mode: 0o700 });
  yield* fileSystem.chmod(homePath, 0o700);
  return homePath;
});

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const EXTENSION_FILENAME = "t3-permission-extension.mjs";

export class PrimeExtensionNotFoundError extends Error {
  override readonly name = "PrimeExtensionNotFoundError";
  readonly searchedPaths: ReadonlyArray<string>;

  constructor(searchedPaths: ReadonlyArray<string>) {
    super(`T3 Prime permission extension was not found: ${searchedPaths.join(", ")}`);
    this.searchedPaths = searchedPaths;
  }
}

export function resolvePrimePermissionExtensionPath(
  moduleUrl = import.meta.url,
  exists: (path: string) => boolean = NodeFS.existsSync,
): string {
  const candidates = [
    new URL(`./extensions/${EXTENSION_FILENAME}`, moduleUrl),
    new URL(`./prime/${EXTENSION_FILENAME}`, moduleUrl),
  ].map((url) => NodeURL.fileURLToPath(url));
  const resolved = candidates.find(exists);
  if (!resolved) throw new PrimeExtensionNotFoundError(candidates);
  return resolved;
}

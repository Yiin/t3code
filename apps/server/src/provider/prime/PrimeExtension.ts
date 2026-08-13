// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const EXTENSION_FILENAME = "t3-permission-extension.mjs";

// A packaged desktop runs the server bundle from resources/app.asar, an archive
// FILE. Electron's asar-aware fs makes existsSync true for paths inside it, but
// prime-agent is a plain process and gets ENOTDIR. electron-builder unpacks the
// server bundle to the app.asar.unpacked sibling (see asarUnpack in
// scripts/build-desktop-artifact.ts), so prefer that copy. The lookahead keeps
// this from touching a path that already names app.asar.unpacked, and outside a
// packaged build nothing matches.
const ASAR_SEGMENT = /(^|[\\/])app\.asar(?=[\\/])/g;

function unpackedSibling(path: string): string | undefined {
  const rewritten = path.replace(ASAR_SEGMENT, "$1app.asar.unpacked");
  return rewritten === path ? undefined : rewritten;
}

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
  ]
    .map((url) => NodeURL.fileURLToPath(url))
    .flatMap((path) => {
      const unpacked = unpackedSibling(path);
      return unpacked ? [unpacked, path] : [path];
    });
  const resolved = candidates.find(exists);
  if (!resolved) throw new PrimeExtensionNotFoundError(candidates);
  return resolved;
}

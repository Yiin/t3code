// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  PrimeExtensionNotFoundError,
  resolvePrimePermissionExtensionPath,
} from "./PrimeExtension.ts";

const extensionUrl = new URL("./extensions/t3-permission-extension.mjs", import.meta.url);

async function loadExtension() {
  const loaded = (await import(extensionUrl.href)) as { default: (pi: unknown) => void };
  return loaded.default;
}

function install(mode: string, choices: ReadonlyArray<string | undefined>) {
  const previous = process.env.T3_PRIME_RUNTIME_MODE;
  process.env.T3_PRIME_RUNTIME_MODE = mode;
  let handler: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
  const pendingChoices = [...choices];
  const select = vi.fn(async () => pendingChoices.shift());
  const pi = {
    on: (_event: string, callback: typeof handler) => {
      handler = callback;
    },
  };
  return loadExtension().then((extension) => {
    extension(pi);
    return {
      select,
      invoke: (event: unknown) => handler?.(event, { ui: { select } }),
      invokeWithContext: (event: unknown, context: unknown) => handler?.(event, context),
      restore: () => {
        if (previous === undefined) delete process.env.T3_PRIME_RUNTIME_MODE;
        else process.env.T3_PRIME_RUNTIME_MODE = previous;
      },
    };
  });
}

describe("Prime permission extension", () => {
  it("never prompts in full access mode", async () => {
    const gate = await install("full-access", []);
    try {
      expect(
        await gate.invoke({ toolName: "ipython", input: { code: "open('/tmp/x','w')" } }),
      ).toBeUndefined();
      expect(gate.select).not.toHaveBeenCalled();
    } finally {
      gate.restore();
    }
  });

  it("gates the full call and scopes allow-for-session to one extension instance", async () => {
    const choices = ["Allow for session"];
    const gate = await install("approval-required", choices);
    try {
      expect(
        await gate.invoke({ toolName: "ipython", input: { code: "print('one')", timeout: 10 } }),
      ).toBeUndefined();
      expect(
        await gate.invoke({ toolName: "ipython", input: { code: "print('two')" } }),
      ).toBeUndefined();
      expect(gate.select).toHaveBeenCalledTimes(1);
      expect(gate.select).toHaveBeenCalledWith(
        expect.stringContaining('"timeout": 10'),
        expect.any(Array),
        expect.objectContaining({ timeout: 300_000 }),
      );
    } finally {
      gate.restore();
    }
  });

  it("allows one call and prompts again for the next call", async () => {
    const gate = await install("approval-required", ["Allow once", "Decline"]);
    try {
      expect(await gate.invoke({ toolName: "ipython", input: { code: "1 + 1" } })).toBeUndefined();
      expect(await gate.invoke({ toolName: "ipython", input: { code: "2 + 2" } })).toMatchObject({
        block: true,
      });
      expect(gate.select).toHaveBeenCalledTimes(2);
    } finally {
      gate.restore();
    }
  });

  it("fails closed on decline, cancellation, malformed UI, and hook failure", async () => {
    for (const choice of ["Decline", "Cancel", undefined]) {
      const gate = await install("approval-required", [choice]);
      try {
        expect(await gate.invoke({ toolName: "python", input: { code: "1" } })).toMatchObject({
          block: true,
        });
      } finally {
        gate.restore();
      }
    }
    const gate = await install("approval-required", ["Allow once"]);
    try {
      await expect(
        gate.invokeWithContext({ toolName: "ipython", input: {} }, {}),
      ).resolves.toMatchObject({ block: true });
      gate.select.mockRejectedValueOnce(new Error("RPC closed"));
      await expect(gate.invoke({ toolName: "ipython", input: null })).resolves.toMatchObject({
        block: true,
      });
    } finally {
      gate.restore();
    }
  });

  it("does not share a session grant with another extension instance", async () => {
    const first = await install("approval-required", ["Allow for session"]);
    const second = await install("approval-required", ["Decline"]);
    try {
      expect(await first.invoke({ toolName: "ipython", input: {} })).toBeUndefined();
      expect(await second.invoke({ toolName: "ipython", input: {} })).toMatchObject({
        block: true,
      });
      expect(first.select).toHaveBeenCalledTimes(1);
      expect(second.select).toHaveBeenCalledTimes(1);
    } finally {
      second.restore();
      first.restore();
    }
  });

  it("resolves source and built layouts without fixed machine paths", () => {
    const sourceModule = NodeURL.pathToFileURL(
      "/checkout/apps/server/src/provider/prime/PrimeExtension.ts",
    ).href;
    const builtModule = NodeURL.pathToFileURL("/package/dist/bin.mjs").href;
    expect(
      resolvePrimePermissionExtensionPath(sourceModule, (path) => path.includes("/extensions/")),
    ).toBe(
      NodePath.normalize(
        "/checkout/apps/server/src/provider/prime/extensions/t3-permission-extension.mjs",
      ),
    );
    expect(
      resolvePrimePermissionExtensionPath(builtModule, (path) => path.includes("/prime/")),
    ).toBe(NodePath.normalize("/package/dist/prime/t3-permission-extension.mjs"));
    expect(() => resolvePrimePermissionExtensionPath(builtModule, () => false)).toThrow(
      PrimeExtensionNotFoundError,
    );
  });

  it("prefers the app.asar.unpacked copy a non-Electron child can read", () => {
    const packagedModule = NodeURL.pathToFileURL(
      "/opt/T3 Code/resources/app.asar/apps/server/dist/bin.mjs",
    ).href;
    // Electron's asar-aware fs reports the in-asar path as existing, and
    // electron-builder unpacks a real copy next to it. Both look present here.
    const resolved = resolvePrimePermissionExtensionPath(packagedModule, (path) =>
      path.includes(`${NodePath.sep}prime${NodePath.sep}`),
    );
    expect(resolved).toBe(
      NodePath.normalize(
        "/opt/T3 Code/resources/app.asar.unpacked/apps/server/dist/prime/t3-permission-extension.mjs",
      ),
    );

    // An already-unpacked path is left alone, so the rewrite never stacks.
    const unpackedModule = NodeURL.pathToFileURL(
      "/opt/T3 Code/resources/app.asar.unpacked/apps/server/dist/bin.mjs",
    ).href;
    expect(
      resolvePrimePermissionExtensionPath(unpackedModule, (path) =>
        path.includes(`${NodePath.sep}prime${NodePath.sep}`),
      ),
    ).toBe(
      NodePath.normalize(
        "/opt/T3 Code/resources/app.asar.unpacked/apps/server/dist/prime/t3-permission-extension.mjs",
      ),
    );
  });
});

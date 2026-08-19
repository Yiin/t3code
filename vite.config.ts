import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  staged: {
    // Formatter only for now — no lint or typecheck on commit.
    "*": "vp fmt",
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".repos/**",
      ".plans",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/web/public/mockServiceWorker.js",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "*.icon/**",
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "oxlint-plugin-anti-slop/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/src/_generated/**",
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "oxlint-plugin-anti-slop/**",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts", "./oxlint-plugin-anti-slop/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@t3tools/client-runtime",
              message:
                "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
            },
          ],
        },
      ],
      // Anti-slop policy after the 2026-08 cleanup (8110 -> 5221 findings):
      // rules at "error" report zero findings today and gate regressions.
      // Rules at "warn" mostly flag correct code — the exactOptionalPropertyTypes
      // omission spread, typeof guards on genuinely-unknown payloads, deliberate
      // test-fixture casts — so they inform without failing the gate.
      "anti-slop/no-chained-type-assertions": "warn",
      "anti-slop/no-conditional-empty-object-spread": "warn",
      "anti-slop/no-known-value-widening": "warn",
      "anti-slop/no-module-mocking": "error",
      // Off: `object` is the right contract for WeakSet keys and structural guards.
      "anti-slop/no-object-parameters": "off",
      "anti-slop/no-reflect-apply": "error",
      // Off: a Proxy get trap must forward its receiver, which needs Reflect.get.
      "anti-slop/no-reflect-get": "off",
      "anti-slop/no-runtime-typeof": "warn",
      // Off: `*Shape` is this repo's name for an Effect service interface. The tag
      // class already owns the plain name, so a rename only swaps one suffix for another.
      "anti-slop/no-shape-in-symbol-names": "off",
      "anti-slop/no-unknown-parameters": "warn",
      "anti-slop/no-unknown-returns": "warn",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "warn",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "warn",
      "t3code/no-global-process-runtime": "error",
      "t3code/no-inline-schema-compile": "warn",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/no-production-projection-snapshot": "error",
      "t3code/namespace-node-imports": "error",
    },
    options: {
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});

import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const SERVICE_MODULE_BASENAME = "ProjectionSnapshotQuery";
const GUARDED_METHOD = "getSnapshot";
const EXEMPT_FILENAME_SUFFIXES = [".test.ts", ".test.tsx", ".integration.ts"];

const message = `ProjectionSnapshotQuery.${GUARDED_METHOD}() has no HTTP surface and is retained for tests only. It reads every message, activity and checkpoint body in one transaction, so it holds the write connection for as long as the read takes. Use getShellSnapshot for project and thread lists, getThreadDetailSnapshot for one thread, or getCommandReadModel for command-side state.`;

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const isExemptFile = (filename: string) => {
  const normalized = normalizePath(filename);
  return EXEMPT_FILENAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
};

const isServiceModuleSpecifier = (specifier: string) => {
  const withoutQuery = normalizePath(specifier).split(/[?#]/u)[0] ?? "";
  const basename = withoutQuery.split("/").pop() ?? "";
  return basename.replace(/\.[cm]?[jt]sx?$/u, "") === SERVICE_MODULE_BASENAME;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: `Disallow production calls to ProjectionSnapshotQuery.${GUARDED_METHOD}(), an unbounded read kept only for tests.`,
    },
  },
  createOnce(context) {
    let importsServiceModule = false;

    return {
      before() {
        importsServiceModule = false;
      },
      ImportDeclaration(node) {
        if (importsServiceModule) return;
        if (isServiceModuleSpecifier(node.source.value)) {
          importsServiceModule = true;
        }
      },
      CallExpression(node) {
        if (!importsServiceModule) return;
        if (isExemptFile(context.filename)) return;

        const callee = unwrapExpression(node.callee);
        if (callee.type !== "MemberExpression") return;

        const property = getPropertyName(callee.property);
        if (Option.isNone(property) || property.value !== GUARDED_METHOD) return;

        context.report({ node, message });
      },
    };
  },
});

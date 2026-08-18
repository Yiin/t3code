import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const RUNTIME_PROPERTIES = new Set(["platform", "arch"]);
const HOST_PROCESS_REFERENCE_FILE = "packages/shared/src/hostProcess.ts";
const NODE_OS_MODULES = new Set(["node:os", "os"]);

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const toRepoPath = (filename: string, cwd: string) => {
  const normalizedFilename = normalizePath(filename);
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/u, "");
  const prefix = `${normalizedCwd}/`;
  return normalizedFilename.startsWith(prefix)
    ? normalizedFilename.slice(prefix.length)
    : normalizedFilename;
};

const isHostProcessReferenceFile = (filename: string, cwd: string) =>
  toRepoPath(filename, cwd) === HOST_PROCESS_REFERENCE_FILE;

const isGlobalProcessObject = (node: ESTree.Node): boolean => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression, "process")) return true;
  if (expression.type !== "MemberExpression") return false;

  const object = unwrapExpression(expression.object);
  const property = getPropertyName(expression.property);
  return (
    isIdentifier(object, "globalThis") && Option.isSome(property) && property.value === "process"
  );
};

const message = (property: string) =>
  `Use HostProcess${property === "arch" ? "Architecture" : "Platform"} instead of process.${property}; inject the runtime reference in Effect code and provide it explicitly in tests.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct host runtime platform/architecture reads outside the shared host process references.",
    },
  },
  createOnce(context) {
    const nodeOsNamespaces = new Set<string>();
    const nodeOsRuntimeImports = new Map<string, string>();

    const resetBindings = () => {
      nodeOsNamespaces.clear();
      nodeOsRuntimeImports.clear();
    };

    const trackImportDeclaration = (node: ESTree.ImportDeclaration) => {
      if (!NODE_OS_MODULES.has(node.source.value)) return;

      for (const specifier of node.specifiers) {
        const localName = specifier.local.name;

        if (
          specifier.type === "ImportNamespaceSpecifier" ||
          specifier.type === "ImportDefaultSpecifier"
        ) {
          nodeOsNamespaces.add(localName);
          continue;
        }

        const imported = getPropertyName(specifier.imported);
        if (Option.isSome(imported) && RUNTIME_PROPERTIES.has(imported.value)) {
          nodeOsRuntimeImports.set(localName, imported.value);
        }
      }
    };

    const getNodeOsRuntimeCall = (callee: ESTree.Node): Option.Option<string> => {
      const expression = unwrapExpression(callee);

      if (expression.type === "Identifier") {
        return Option.fromNullishOr(nodeOsRuntimeImports.get(expression.name));
      }

      if (expression.type !== "MemberExpression") return Option.none();

      const object = unwrapExpression(expression.object);
      if (object.type !== "Identifier") return Option.none();
      if (!nodeOsNamespaces.has(object.name)) return Option.none();

      return Option.filter(getPropertyName(expression.property), (property) =>
        RUNTIME_PROPERTIES.has(property),
      );
    };

    return {
      before: resetBindings,
      ImportDeclaration: trackImportDeclaration,
      MemberExpression(node) {
        if (isHostProcessReferenceFile(context.filename, context.cwd)) return;

        const property = getPropertyName(node.property);
        if (Option.isNone(property) || !RUNTIME_PROPERTIES.has(property.value)) return;
        if (!isGlobalProcessObject(node.object)) return;

        context.report({
          node,
          message: message(property.value),
        });
      },
      CallExpression(node) {
        if (isHostProcessReferenceFile(context.filename, context.cwd)) return;

        const property = getNodeOsRuntimeCall(node.callee);
        if (Option.isNone(property)) return;

        context.report({
          node,
          message: message(property.value),
        });
      },
    };
  },
});

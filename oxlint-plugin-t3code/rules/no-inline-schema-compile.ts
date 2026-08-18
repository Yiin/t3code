import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

// Effect Schema decoder/encoder APIs allocate compiled functions. Keep them
// outside function bodies so hot paths do not rebuild compilers per call.
const COMPILER_METHODS: ReadonlySet<string> = new Set<keyof typeof Schema>([
  "is",
  "asserts",
  "decodeEffect",
  "decodeExit",
  "decodeOption",
  "decodePromise",
  "decodeResult",
  "decodeSync",
  "decodeUnknownExit",
  "decodeUnknownEffect",
  "decodeUnknownOption",
  "decodeUnknownPromise",
  "decodeUnknownResult",
  "decodeUnknownSync",

  "encodeExit",
  "encodeEffect",
  "encodeOption",
  "encodePromise",
  "encodeResult",
  "encodeSync",
  "encodeUnknownExit",
  "encodeUnknownEffect",
  "encodeUnknownOption",
  "encodeUnknownPromise",
  "encodeUnknownResult",
  "encodeUnknownSync",
]);

const getSchemaCompilerMethod = (callee: ESTree.Node): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (expression.type !== "MemberExpression") return Option.none();

  const object = unwrapExpression(expression.object);
  if (!isIdentifier(object, "Schema")) return Option.none();

  return Option.filter(getPropertyName(expression.property), (method) =>
    COMPILER_METHODS.has(method),
  );
};

const isStaticSchemaReference = (node: ESTree.Node): boolean => {
  const expression = unwrapExpression(node);

  if (expression.type === "Identifier") {
    const [firstChar] = expression.name;
    return firstChar !== undefined && firstChar.toUpperCase() === firstChar;
  }

  return expression.type === "MemberExpression";
};

const isNestedStaticSchemaCall = (node: ESTree.Node): boolean => {
  const expression = unwrapExpression(node);
  if (expression.type !== "CallExpression") return false;

  const callee = unwrapExpression(expression.callee);
  if (callee.type !== "MemberExpression") return false;

  const object = unwrapExpression(callee.object);
  if (!isIdentifier(object, "Schema")) return false;

  const method = getPropertyName(callee.property);
  if (Option.isSome(method) && method.value === "fromJsonString") {
    const firstArg = expression.arguments[0];
    if (firstArg === undefined) return false;
    return isStaticSchemaReference(firstArg) || isNestedStaticSchemaCall(firstArg);
  }

  return true;
};

const isImmediatelyInvoked = (node: ESTree.Node): boolean => {
  const expression = unwrapExpression(node);
  if (expression.parent === null) return false;

  const parent = unwrapExpression(expression.parent);
  return parent.type === "CallExpression" && unwrapExpression(parent.callee) === expression;
};

const messageHigh = (method: string) =>
  `Hoist Schema.${method}(...) to module scope: both the inline schema literal and the compiled function are rebuilt on every call. Move the compiled function to a module-level const.`;

const messageMedium = (method: string) =>
  `Hoist Schema.${method}(...) to module scope: the compiled function is rebuilt on every call. Move it to a module-level const.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Schema decoder/encoder compiler calls inside function bodies; hoist them to module scope.",
    },
  },
  createOnce(context) {
    let functionDepth = 0;

    const resetFunctionDepth = () => {
      functionDepth = 0;
    };

    const enterFunction = () => {
      functionDepth++;
    };

    const exitFunction = () => {
      functionDepth--;
    };

    return {
      before: resetFunctionDepth,
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      CallExpression(node) {
        if (functionDepth === 0) return;

        const method = getSchemaCompilerMethod(node.callee);
        if (Option.isNone(method)) return;
        if (!isImmediatelyInvoked(node)) return;

        const firstArg = node.arguments[0];
        if (firstArg === undefined) return;

        const high = isNestedStaticSchemaCall(firstArg);
        if (!high && !isStaticSchemaReference(firstArg)) return;

        context.report({
          node: node.callee,
          message: high ? messageHigh(method.value) : messageMedium(method.value),
        });
      },
    };
  },
});

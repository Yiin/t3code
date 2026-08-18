import type { ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

type ExpressionWrapper =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSAsExpression
  | ESTree.TSTypeAssertion;

const isExpressionWrapper = (node: ESTree.Node): node is ExpressionWrapper =>
  node.type === "ChainExpression" ||
  node.type === "ParenthesizedExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSTypeAssertion";

export function unwrapExpression(node: ESTree.Node): ESTree.Node {
  let current: ESTree.Node = node;

  while (isExpressionWrapper(current)) {
    current = current.expression;
  }

  return current;
}

export function getPropertyName(node: ESTree.Node): Option.Option<string> {
  if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
    return Option.some(node.name);
  }
  // `Literal` covers every literal kind, so `value` is a genuine union here.
  if (node.type === "Literal" && typeof node.value === "string") {
    return Option.some(node.value);
  }
  return Option.none();
}

export function isIdentifier(node: ESTree.Node, name?: string): boolean {
  return node.type === "Identifier" && (name === undefined || node.name === name);
}

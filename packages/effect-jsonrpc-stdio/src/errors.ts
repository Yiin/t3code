import type * as SchemaIssue from "effect/SchemaIssue";
import * as Schema from "effect/Schema";

export const SchemaIssueKind = Schema.Literals([
  "Filter",
  "Encoding",
  "Pointer",
  "Composite",
  "AnyOf",
  "InvalidType",
  "InvalidValue",
  "MissingKey",
  "UnexpectedKey",
  "Forbidden",
  "OneOf",
]);
export type SchemaIssueKind = typeof SchemaIssueKind.Type;

export interface SchemaIssueDiagnostics {
  readonly issueCount: number;
  readonly issueKinds: ReadonlyArray<SchemaIssueKind>;
  readonly maximumPathDepth: number;
}

export const schemaIssueDiagnostics = (root: SchemaIssue.Issue): SchemaIssueDiagnostics => {
  let issueCount = 0;
  let maximumPathDepth = 0;
  const issueKinds = new Set<SchemaIssueKind>();

  const visit = (issue: SchemaIssue.Issue, pathDepth: number): void => {
    issueCount += 1;
    issueKinds.add(issue._tag);
    maximumPathDepth = Math.max(maximumPathDepth, pathDepth);
    switch (issue._tag) {
      case "Filter":
      case "Encoding":
        visit(issue.issue, pathDepth);
        break;
      case "Pointer":
        visit(issue.issue, pathDepth + issue.path.length);
        break;
      case "Composite":
      case "AnyOf":
        for (const child of issue.issues) visit(child, pathDepth);
        break;
    }
  };

  visit(root, 0);
  return { issueCount, issueKinds: [...issueKinds], maximumPathDepth };
};

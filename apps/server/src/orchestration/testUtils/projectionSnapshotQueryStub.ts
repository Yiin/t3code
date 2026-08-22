/**
 * projectionSnapshotQueryStub - a fully populated ProjectionSnapshotQuery double.
 *
 * A test that needs one or two projection reads used to write a partial object
 * literal and force it through `as unknown as ProjectionSnapshotQueryShape`.
 * That cast accepts a misspelled method name and a wrong return shape alike, so
 * a stub could drift from the service it stands in for and the test would still
 * compile.
 *
 * Spreading this record instead keeps the override type-checked: the method name
 * has to exist and its signature has to match. Every read a test does not
 * override dies with its own name, so an unexpected read reports which one it
 * was rather than a `not a function` TypeError.
 *
 * `getTurnByPendingMessageId` is deliberately absent. It is optional on the
 * service and `ThreadSettleWatch` branches on whether it is defined, so filling
 * it here would change what the callers under test do.
 *
 * @module projectionSnapshotQueryStub
 */
import * as Effect from "effect/Effect";

import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";

const unsupported = (call: string) => () =>
  Effect.die(new Error(`ProjectionSnapshotQuery.${call} is not stubbed in this test`));

/** Every required projection read, each one dying with its own name. */
export const unsupportedProjectionSnapshotQuery: ProjectionSnapshotQueryShape = {
  getCommandReadModel: unsupported("getCommandReadModel"),
  getSnapshot: unsupported("getSnapshot"),
  getShellSnapshot: unsupported("getShellSnapshot"),
  getArchivedShellSnapshot: unsupported("getArchivedShellSnapshot"),
  getSnapshotSequence: unsupported("getSnapshotSequence"),
  getCounts: unsupported("getCounts"),
  getActiveProjectByWorkspaceRoot: unsupported("getActiveProjectByWorkspaceRoot"),
  getProjectShellById: unsupported("getProjectShellById"),
  getFirstActiveThreadIdByProjectId: unsupported("getFirstActiveThreadIdByProjectId"),
  getThreadCheckpointContext: unsupported("getThreadCheckpointContext"),
  getFullThreadDiffContext: unsupported("getFullThreadDiffContext"),
  listSubagentTurnContributions: unsupported("listSubagentTurnContributions"),
  getThreadShellById: unsupported("getThreadShellById"),
  getThreadSessionById: unsupported("getThreadSessionById"),
  getThreadSubagentLiveness: unsupported("getThreadSubagentLiveness"),
  getSubagentActivities: unsupported("getSubagentActivities"),
  listChildThreadIds: unsupported("listChildThreadIds"),
  listRunningThreadBackedSubagents: unsupported("listRunningThreadBackedSubagents"),
  listRunningInProcessSubagents: unsupported("listRunningInProcessSubagents"),
  listThreadIdsWithQueuedMessages: unsupported("listThreadIdsWithQueuedMessages"),
  getThreadDetailById: unsupported("getThreadDetailById"),
  getThreadDetailSnapshot: unsupported("getThreadDetailSnapshot"),
};

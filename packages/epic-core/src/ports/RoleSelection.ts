/** Per-role model selection, resolved once per epic dispatch. */
import type * as Effect from "effect/Effect";

import type { AgentSelection } from "./AgentDispatch.ts";

/**
 * One dispatch the runner controls.
 *
 * Planner, implementer and reviewer are in-session subagents, not runner
 * dispatches, so they are not roles here.
 */
export type EpicDispatchRole =
  | "iteration-worker"
  | "merge-fix-child"
  | "idle-inspector"
  | "note-fold";

export interface RoleSelectionRequest {
  readonly role: EpicDispatchRole;
  readonly runId: string;
  readonly issueId: string | null;
  readonly issueTitle: string | null;
  /** The run-level selection; the adapter returns this when the role has no tier. */
  readonly fallbackSelection: AgentSelection;
}

export interface RoleSelectionShape {
  /** Never fails. On any error the adapter returns request.fallbackSelection. */
  readonly resolve: (request: RoleSelectionRequest) => Effect.Effect<AgentSelection>;
}

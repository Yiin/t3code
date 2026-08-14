/** Per-role model selection, resolved once per epic dispatch. */
import type { EpicRoleId, EpicTierId } from "@t3tools/contracts";
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

/** Map the loop's dispatch vocabulary onto the settings policy vocabulary. */
export const epicDispatchRoleId = (role: EpicDispatchRole): EpicRoleId => {
  switch (role) {
    case "iteration-worker":
      return "iteration-worker";
    case "merge-fix-child":
      return "merge-fix";
    case "idle-inspector":
      return "idle-inspection";
    case "note-fold":
      return "epic-note-fold";
    default: {
      const exhaustive: never = role;
      return exhaustive;
    }
  }
};

export interface RoleSelectionRequest {
  readonly role: EpicDispatchRole;
  readonly runId: string;
  readonly issueId: string | null;
  readonly issueTitle: string | null;
  /** The run-level selection; the adapter returns this when the role has no tier. */
  readonly fallbackSelection: AgentSelection;
}

/**
 * What one role resolution decided, and where the decision came from.
 *
 * `tierId` is the attribution half: it names the tier whose chain produced
 * `selection`, so an iteration outcome can be counted against that tier later.
 * `null` means no tier answered — the role has none configured, or the
 * adapter fell back to `request.fallbackSelection`.
 */
export interface ResolvedRoleSelection {
  readonly selection: AgentSelection;
  readonly tierId: EpicTierId | null;
}

export interface RoleSelectionShape {
  /**
   * Never fails. On any error the adapter returns `request.fallbackSelection`
   * with a `null` tier, because nothing was actually resolved.
   */
  readonly resolve: (request: RoleSelectionRequest) => Effect.Effect<ResolvedRoleSelection>;
}

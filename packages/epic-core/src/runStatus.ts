import type { EpicRunStatus } from "@t3tools/contracts";

/**
 * Statuses a run never leaves once reached. The terminal set is named exactly
 * once here; the server runner, its lifecycle adapter, and the CLI all guard
 * on it.
 */
export const isEpicRunTerminal = (status: EpicRunStatus): boolean =>
  status === "done" || status === "failed" || status === "cancelled";

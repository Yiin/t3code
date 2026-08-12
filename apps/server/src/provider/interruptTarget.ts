import type { TurnId } from "@t3tools/contracts";

/** Untargeted interrupts keep their legacy session-wide behavior. */
export const isInterruptTargetCurrent = (
  activeTurnId: TurnId | undefined,
  targetTurnId: TurnId | undefined,
): boolean => targetTurnId === undefined || activeTurnId === targetTurnId;

/** The provider-neutral boundary used to start and control an agent iteration. */
import { ModelSelection } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Keep provider selection identical across server and terminal adapters. */
export const AgentSelection = ModelSelection;
export type AgentSelection = ModelSelection;

/**
 * How an adapter can adopt work whose iteration handle is gone.
 *
 * `adopt-ref` means the adapter can pick the work up again from the ref it
 * persisted (a server thread id). `unsupported` means it cannot, and must
 * say so instead of starting a blank session that looks like a resume.
 */
export type IterationResumeMode = "adopt-ref" | "unsupported";

/**
 * Session-lifecycle capabilities, one key per operation.
 *
 * `fork` is deliberately absent. When forking lands it is an ADDED KEY here,
 * never a changed type, so an adapter that only resumes keeps compiling.
 */
export interface AgentLifecycleCapabilities {
  readonly resume: IterationResumeMode;
}

export interface AgentDispatchCapabilities {
  readonly terminalSignal: "projection" | "process-exit" | "turn-record" | "step-record";
  /**
   * How to continue a turn on a handle this process still holds. This is NOT
   * the resume question: see {@link AgentLifecycleCapabilities.resume} for
   * adopting work whose handle died.
   */
  readonly continuation: "same-thread" | "resume-command" | "none";
  readonly subagentLiveness: SubagentLiveness["mode"];
  readonly finalMessage:
    | "projection"
    | "result-field"
    | "assistant-jsonl"
    | "agent-item-jsonl"
    | "step-text-jsonl"
    | "raw-text";
  /** Whether final assistant prose is trusted as provider-owned failure evidence. */
  readonly providerErrors: "session-only" | "session-and-assistant";
  readonly cost: "total-cost-usd" | "step-cost" | "none";
  readonly lifecycle: AgentLifecycleCapabilities;
}

/** Why an adapter declined to adopt an iteration. */
export type IterationResumeRefusal =
  | { readonly _tag: "capability"; readonly detail: string }
  | { readonly _tag: "no-durable-state"; readonly detail: string }
  | {
      readonly _tag: "not-continued";
      readonly origin: "started-fresh" | "forked" | "unknown";
      readonly detail: string;
    }
  /**
   * The adapter accepted the resume and then errored on it. Still a refusal
   * and not a failure: the work is untouched, the agent heard nothing, and
   * the caller's answer is the same as for every other arm — start this child
   * fresh in the tree the dead one left.
   */
  | { readonly _tag: "failed"; readonly detail: string };

/**
 * The outcome of adopting an iteration. Both this union and
 * {@link IterationResumeRefusal} are open by construction, so a `forked` arm
 * is additive later.
 */
export type IterationResume =
  | { readonly _tag: "resumed"; readonly handle: IterationHandle }
  | { readonly _tag: "unavailable"; readonly refusal: IterationResumeRefusal };

export interface IterationSettle {
  readonly turnState: "completed" | "error" | "interrupted";
  readonly timedOut: boolean;
  readonly providerError: string | null;
}

export interface FinalMessageRead {
  readonly text: string | null;
  readonly streaming: boolean;
  readonly waitExhausted: boolean;
  /**
   * Server projection reads carry the settled turn and session state of the
   * same snapshot, so classification reads one consistent projection.
   */
  readonly turnState?: "completed" | "error" | "interrupted" | null;
  readonly sessionLastError?: string | null;
}

export type AuxiliaryPurpose = "idle-inspection" | "epic-note-fold";

export interface AuxiliaryResult {
  readonly output: string;
  readonly succeeded: boolean;
}

/**
 * Subagent liveness evidence without false parity between adapters.
 *
 * Native and event-bookkeeping modes count known agents. External mode uses
 * owned-process and activity evidence. Unavailable mode skips continuation and
 * emits a visible degradation event. It must never impersonate a zero count.
 */
export type SubagentLiveness =
  | { readonly mode: "native"; readonly running: number }
  | { readonly mode: "event-bookkeeping"; readonly running: number }
  | { readonly mode: "external"; readonly active: boolean; readonly evidence: string }
  | { readonly mode: "unavailable"; readonly reason: string };

export class DispatchError extends Schema.TaggedErrorClass<DispatchError>()("DispatchError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface IterationHandle {
  /** A server thread id or a terminal artifact path. */
  readonly ref: string;
  readonly capabilities: AgentDispatchCapabilities;
  readonly awaitSettled: Effect.Effect<IterationSettle, DispatchError>;
  readonly continueTurn: (prompt: string) => Effect.Effect<void, DispatchError>;
  readonly interrupt: Effect.Effect<void, DispatchError>;
  readonly release: Effect.Effect<void, DispatchError>;
  /**
   * Read fresh subagent liveness for grace-continuation policy.
   *
   * A terminal adapter can lack native liveness data. It must state and apply
   * an explicit degraded mode. It must not silently report zero.
   */
  readonly runningSubagents: Effect.Effect<SubagentLiveness, DispatchError>;
  readonly finalMessage: Effect.Effect<FinalMessageRead, DispatchError>;
}

export interface AgentDispatchShape {
  /**
   * What this dispatch can do, readable with no handle. A restart decides
   * whether to adopt an iteration before it owns one, so the declaration
   * cannot live on {@link IterationHandle} alone.
   */
  readonly capabilities: AgentDispatchCapabilities;
  readonly startIteration: (input: {
    readonly runId: string;
    readonly iterationIndex: number;
    readonly cwd: string;
    readonly worktreePath: string | null;
    readonly prompt: string;
    readonly selection: AgentSelection;
  }) => Effect.Effect<IterationHandle, DispatchError>;
  /** Run policy support work without creating an iteration record. */
  readonly runAuxiliary: (input: {
    readonly purpose: AuxiliaryPurpose;
    readonly cwd: string;
    readonly prompt: string;
    readonly selection: AgentSelection;
  }) => Effect.Effect<AuxiliaryResult, DispatchError>;
}
